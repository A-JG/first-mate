// The dispatcher. Runs on the computer that holds the projects.
//
//   phone app  ──audio, playback──▶  ┐
//   desk page  ──typed text──────▶  ├─ WebSocket /radio ─▶ Radio ─▶ Agents ─▶ claude -p
//              ◀─say, tones, state─  ┘        ▲
//                         speech worker ──────┘ (stt/worker.py, local Whisper)
//
// Clients are deliberately dumb: they send what was heard (or raw audio) and
// play what they are told to say. All procedure lives here.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';
import { Agents } from './agents.js';
import { Radio } from './radio.js';
import { runTurn } from './claude.js';
import { makeRouter, makeSorter, listProjects } from './router.js';
import { buildGuide } from './guide.js';
import { SpeechToText, hintPrompt } from './stt.js';
import { Voice } from './tts.js';
import { isLoopback, allowed, addresses, loadToken, sameSecret, Pairing } from './net.js';
import { Peers, TurnHost, peerRoutes } from './peers.js';
import { listSessions } from './sessions.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

const config = {
  host: '', port: 7373, allow: 'tailscale', projectRoots: ['~/Projects'], permissionMode: 'acceptEdits', peers: [],
  ...readJson(process.env.FIRSTMATE_CONFIG ?? join(root, 'config.json'), {}),
};
config.dataDir = resolve(root, process.env.FIRSTMATE_DATA ?? config.dataDir ?? 'data');
if (process.env.FIRSTMATE_PORT) config.port = Number(process.env.FIRSTMATE_PORT);
mkdirSync(config.dataDir, { recursive: true });
const token = config.token || loadToken(join(config.dataDir, 'token'));
const pairing = new Pairing();

// The language pack: command words, thread names and the dispatcher's voice.
const pack = readJson(join(root, 'packs', `${config.pack ?? 'pirate'}.json`));
if (!pack) throw new Error(`No language pack named "${config.pack}" in packs/`);
const skill = readFileSync(join(root, 'skills/radio-brief/SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
// A pack may add a voice for agent reports on top of the listening rules.
const briefing = pack.reportVoice ? `${skill}\n\n${pack.reportVoice}` : skill;
const secret = randomBytes(24).toString('hex'); // shared with approval bridges only

// ---- transcript fan-out ----
const clients = new Set();
const history = [];
const send = (ws, event) => { if (ws.readyState === 1) ws.send(JSON.stringify(event)); };
const phones = () => [...clients].filter((c) => c.authed && c.role === 'radio' && c.readyState === 1);

// The First Mate's voice, made here and streamed to phones a sentence at a time.
const voice = new Voice({
  root,
  voice: pack.voice ?? {},
  onChunk: ({ pcm, ...head }) => {
    for (const ws of phones()) {
      ws.send(JSON.stringify({ ...head, type: 'audio' }));
      ws.send(pcm, { binary: true });
    }
  },
});
// Lines carry `audio: true` when the computer will stream them; otherwise the
// phone speaks them with its own voice.
const withVoice = (event) => {
  if (event.type !== 'say' || !voice.ready || !phones().length) return event;
  const member = event.speaker && crewByName.get(String(event.speaker).toLowerCase());
  voice.speak({ ...event, voice: member?.voice });
  return { ...event, audio: true };
};

let draftShown = null;
const followDraft = (state) => {
  const draft = state.composing ?? '';
  if (draft === draftShown) return;
  draftShown = draft;
  stt.setPause(draft ? 1.4 : 0.7);
  refreshHints(draft);
};

const broadcast = (event) => {
  event = withVoice(event);
  if (event.type === 'state') { try { followDraft(event.state); } catch { /* recogniser not up yet */ } }
  if (event.type === 'stop') voice.cancel();
  if (event.type === 'say' || event.type === 'heard') {
    history.push({ ...event, t: Date.now() });
    if (history.length > 80) history.shift();
  }
  for (const ws of clients) if (ws.authed) send(ws, event);
  if (event.type === 'say') console.log(`  >> ${event.text}`);
  if (event.type === 'heard') console.log(`<< ${event.text}${event.ignored ? `   (ignored: ${event.ignored})` : ''}`);
};

// ---- agents and the radio ----
// The crew: named pirates with a trade, a personality and a voice each.
const crew = pack.crew ?? [];
const crewByName = new Map(crew.map((c) => [c.name.toLowerCase(), c]));
const store = new Store({ file: join(config.dataDir, 'state.json'), callsigns: pack.callsigns, crew });
// Who the agent is: added to the report rules so each pirate sounds like themself.
const persona = (callsign) => {
  const c = crewByName.get(String(callsign).toLowerCase());
  if (!c) return '';
  return `\n\n## Who you are\n\nYou are ${c.title}, one of the captain's crew. ${c.personality}\n\nSpeak in that character in the radio block, within the rules above: the facts stay plain and complete. Never call yourself the captain or the First Mate.`;
};
// One agent turn in a folder on this computer, for a thread here or for a hub.
// Permissions are always this computer's own settings; approvals go through
// this dispatcher's bridge (and on to the hub, for a hub's turn).
const localTurn = ({ cwd, prompt, sessionId, resume, fork, model, effort, appendSystemPrompt, approvalThread, onEvent }) => runTurn({
  bin: config.claudeBin,
  cwd,
  prompt,
  sessionId,
  resume,
  fork,
  // Opus 5.5 at high effort unless the operator asked for something else.
  model: model || config.agentModel || 'claude-opus-5-5',
  effort: effort || config.agentEffort || 'high',
  permissionMode: config.permissionMode,
  allowedTools: config.allowedTools,
  appendSystemPrompt,
  permissionTool: 'mcp__firstmate__approve',
  mcpConfig: {
    mcpServers: {
      firstmate: {
        command: process.execPath,
        args: [join(root, 'src/approve-mcp.js')],
        env: { FIRSTMATE_URL: `http://127.0.0.1:${config.port}`, FIRSTMATE_THREAD: approvalThread, FIRSTMATE_SECRET: secret },
      },
    },
  },
  onEvent,
});

// ---- other computers ----
// Dispatchers on other computers whose projects this one can send work to.
const peers = new Peers({ peers: config.peers, file: join(config.dataDir, 'peers.json') });
// Turns this computer runs for another dispatcher.
const turnHost = new TurnHost({
  run: (t) => {
    console.log(`Turn for another dispatcher in ${t.cwd}`);
    return localTurn({ ...t, approvalThread: `peer:${t.turnId}` });
  },
});
const allProjects = () => [...listProjects(config), ...peers.projects()];
// Recent Claude Code sessions here and on the peers, except the ones this
// dispatcher's own threads already hold.
const allSessions = () => {
  const mine = new Set(store.threads.map((t) => t.sessionId));
  return [...listSessions(listProjects(config)), ...peers.sessions()]
    .filter((x) => !mine.has(x.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 40);
};

let radio;
const agents = new Agents({
  store,
  onItem: (item) => radio.notify(item),
  onChange: () => radio.emitState(),
  runTurn: ({ thread, prompt, onEvent }) => {
    const turn = {
      prompt,
      sessionId: thread.sessionId,
      resume: thread.started,
      fork: thread.fork,
      model: thread.model || config.agentModel || 'claude-opus-5-5',
      effort: thread.effort || config.agentEffort || 'high',
      appendSystemPrompt: briefing + persona(thread.callsign),
    };
    if (thread.host) {
      return peers.runTurn(thread.host, {
        ...turn, project: thread.remote, cwd: thread.cwd, onEvent,
        onApproval: ({ toolName, input }) => agents.requestApproval({ threadId: thread.id, toolName, input }),
      });
    }
    return localTurn({ ...turn, cwd: thread.cwd, approvalThread: thread.id, onEvent });
  },
});
agents.recover();

radio = new Radio({
  store,
  agents,
  pack,
  config,
  route: makeRouter(config, crew.length ? pack.roles : null),
  sort: makeSorter(config),
  projects: allProjects,
  sessions: allSessions,
  // Runs only after the operator confirms the read-back.
  createProject: ({ cwd }) => {
    mkdirSync(cwd, { recursive: true });
    if (!existsSync(join(cwd, '.git'))) spawnSync('git', ['init', '-q'], { cwd });
  },
  out: broadcast,
});

// ---- speech recognition ----
// Whether the utterance being heard overlapped the dispatcher's own voice: if
// so it is the dispatcher's echo or the operator talking over it, and only the
// interrupt word counts, even if it finishes after the dispatcher stops.
let overlapped = false;
let quietTimer = null;
const stt = new SpeechToText({
  root,
  model: config.sttModel,
  onText: (text) => {
    clearTimeout(quietTimer);
    const was = overlapped || radio.speaking();
    overlapped = radio.speaking();
    radio.hear(text, { voice: true, overlapped: was });
  },
  onDropped: () => {
    clearTimeout(quietTimer);
    overlapped = radio.speaking();
    radio.dropped();
  },
  onSpeech: (on) => {
    clearTimeout(quietTimer);
    if (on) {
      overlapped = overlapped || radio.speaking();
      // The operator started talking: the First Mate pauses at once.
      radio.pauseForOperator();
    } else {
      // Nothing came of it within a few seconds: carry on talking.
      quietTimer = setTimeout(() => radio.dropped(), 4000);
    }
    radio.setUserTalking(on);
    broadcast({ type: 'vad', on });
  },
});
let lastHints = '';
let draftTail = '';
const refreshHints = (draft = draftTail) => {
  draftTail = draft;
  // Whisper keeps the style and context of what came just before.
  const prompt = `${hintPrompt(pack, allProjects())}${draft ? ` ${draft.slice(-240)}` : ''}`;
  if (prompt !== lastHints) { lastHints = prompt; stt.setHints(prompt); }
};
// A dispatcher that only runs work for another one needs no ears or voice.
if (config.speech !== false) { stt.start(); voice.start(); }
refreshHints();
setInterval(refreshHints, 60_000).unref();
const refreshPeers = () => peers.refresh()
  .then((changed) => { if (changed) { refreshHints(); radio.emitState(); } })
  .catch((e) => console.error('peer check failed:', e.message));
refreshPeers();
setInterval(refreshPeers, config.peerRefreshMs ?? 30_000).unref();

// Devices that play speech aloud and report progress; while one is playing,
// only the interrupt word is listened for.
const updateSpeakers = () => radio.setSpeakers([...clients].filter((c) => c.authed && c.speaker).length);
let micOwner = null; // only one phone feeds the recogniser at a time
const stats = { audioBytes: 0, playbackReports: 0, lastPlayback: null };

// ---- HTTP ----
const readBody = (req) => new Promise((res, rej) => {
  let b = '';
  req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy(); });
  req.on('end', () => res(b));
  req.on('error', rej);
});
const zipped = new Map(); // vendored script path -> gzipped bytes
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const MODEL = /^[A-Za-z0-9][\w.:[\]-]*$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const peerApi = peerRoutes({
  host: turnHost,
  info: () => {
    const projects = listProjects(config);
    const mine = new Set(store.threads.map((t) => t.sessionId));
    return { name: config.name ?? hostname(), projects, sessions: listSessions(projects).filter((x) => !mine.has(x.id)) };
  },
  // Only folders inside this computer's own projects, and only its own permission settings.
  prepare: (b) => {
    const project = listProjects(config).find((p) => p.name === b.project);
    if (!project) throw new Error(`There is no project called ${b.project} here.`);
    const cwd = b.cwd ? resolve(String(b.cwd)) : project.cwd;
    if (cwd !== project.cwd && !cwd.startsWith(project.cwd + sep)) throw new Error('That folder is outside the project.');
    if (!existsSync(cwd)) throw new Error(`${cwd} is not on this computer.`);
    if (b.sessionId && !/^[0-9a-f-]{36}$/i.test(b.sessionId)) throw new Error('Bad session id.');
    if (!String(b.prompt ?? '').trim()) throw new Error('No instruction.');
    return {
      cwd,
      prompt: String(b.prompt),
      sessionId: b.sessionId || undefined,
      resume: Boolean(b.resume && b.sessionId),
      fork: Boolean(b.fork),
      model: MODEL.test(b.model ?? '') ? b.model : undefined,
      effort: EFFORTS.has(b.effort) ? b.effort : undefined,
      appendSystemPrompt: typeof b.appendSystemPrompt === 'string' ? b.appendSystemPrompt : briefing,
    };
  },
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const addr = req.socket.remoteAddress;
  const local = isLoopback(addr);
  if (!allowed(addr, config.allow)) { res.writeHead(403).end(); return; }
  const authed = local || sameSecret(url.searchParams.get('t') ?? req.headers['x-firstmate-token'], token);

  // Approval bridge: only from this machine, only with this run's secret.
  if (req.method === 'POST' && url.pathname === '/internal/approve') {
    if (!local || req.headers['x-firstmate-secret'] !== secret) { res.writeHead(403).end(); return; }
    try {
      const ask = JSON.parse(await readBody(req));
      // A turn run for another dispatcher asks that dispatcher's operator.
      const answer = String(ask.threadId).startsWith('peer:')
        ? await turnHost.approval(ask.threadId.slice(5), ask)
        : await agents.requestApproval(ask);
      json(res, 200, answer);
    } catch (e) {
      json(res, 400, { allow: false, message: e.message });
    }
    return;
  }

  // Another dispatcher sending work here.
  if (url.pathname.startsWith('/peer/')) {
    if (!authed) { res.writeHead(401).end(); return; }
    await peerApi(req, res, url, readBody);
    return;
  }

  // This dispatcher's peers, managed from this computer only (npm run peer).
  if (url.pathname === '/peers') {
    if (!local) { res.writeHead(403).end(); return; }
    if (req.method === 'GET') { json(res, 200, { peers: peers.status() }); return; }
    if (req.method === 'POST') {
      try {
        const b = JSON.parse(await readBody(req));
        const peer = await peers.pair({ name: b.name, url: b.url, code: b.code, device: `First Mate on ${config.name ?? hostname()}` });
        refreshHints();
        radio.emitState();
        json(res, 200, { peer });
      } catch (e) {
        json(res, 400, { error: e.message });
      }
      return;
    }
    if (req.method === 'DELETE') {
      json(res, peers.remove(url.searchParams.get('name')) ? 200 : 404, { peers: peers.status() });
      return;
    }
  }

  // A phone (or another dispatcher) trades a pairing code for the key.
  if (req.method === 'POST' && url.pathname === '/pair') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* empty */ }
    if (!pairing.redeem(body.code)) { json(res, 403, { error: 'That code is wrong or has expired.' }); return; }
    console.log(`Paired ${/^First Mate on /.test(body.device ?? '') ? 'a dispatcher' : 'a phone'} (${body.device ?? 'unknown device'}) from ${addr}.`);
    json(res, 200, { token });
    return;
  }

  // Pairing screen, shown only on this computer.
  if (req.method === 'GET' && url.pathname === '/pair') {
    if (!local) { res.writeHead(403).end(); return; }
    const { code, expires } = pairing.current() ?? pairing.issue();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(pairPage({ code, expires, where: addresses(), port: config.port }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/pair/new') {
    if (!local) { res.writeHead(403).end(); return; }
    json(res, 200, pairing.issue());
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(readFileSync(join(root, 'public/index.html')));
    return;
  }
  // Fonts ship with First Mate so the screen looks right with no internet.
  if (req.method === 'GET' && /^\/fonts\/[A-Za-z0-9-]+\.ttf$/.test(url.pathname)) {
    const file = join(root, 'public', url.pathname);
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'public, max-age=2592000' });
    res.end(readFileSync(file));
    return;
  }
  // The 3D ship and its vendored three.js (public/vendor). Compressed, because
  // the phone may be on a thin signal.
  if (req.method === 'GET' && /^\/(ship3d|vendor\/[A-Za-z0-9.-]+)\.js$/.test(url.pathname) && !url.pathname.includes('..')) {
    const file = join(root, 'public', url.pathname);
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    const vendored = url.pathname.startsWith('/vendor/');
    const head = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': vendored ? 'public, max-age=2592000' : 'no-cache', vary: 'accept-encoding' };
    const body = readFileSync(file);
    if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
      if (!vendored) { res.writeHead(200, { ...head, 'content-encoding': 'gzip' }).end(gzipSync(body)); return; }
      if (!zipped.has(file)) zipped.set(file, gzipSync(body));
      res.writeHead(200, { ...head, 'content-encoding': 'gzip' }).end(zipped.get(file));
      return;
    }
    res.writeHead(200, head).end(body);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/pack.json') {
    if (!authed) { res.writeHead(401).end(); return; }
    const { reportVoice, ...shown } = pack;
    json(res, 200, { ...shown, guide: buildGuide(pack) });
    return;
  }
  // The Android app, for installing straight onto a phone over Tailscale.
  if (req.method === 'GET' && url.pathname === '/firstmate.apk') {
    const apk = join(root, 'android/build/FirstMate.apk');
    if (!existsSync(apk)) { res.writeHead(404).end('Not built yet. Run: npm run build:apk'); return; }
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-disposition': 'attachment; filename="FirstMate.apk"',
      'cache-control': 'no-store',
    });
    res.end(readFileSync(apk));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true, speech: stt.ready, voice: voice.ready, threads: store.open.length, waiting: store.queue.length,
      phones: [...clients].filter((c) => c.authed && c.role === 'radio').length,
      speakers: radio.speakers, speaking: radio.speaking(),
      audioSeconds: Math.round(stats.audioBytes / 32000), playbackReports: stats.playbackReports, lastPlayback: stats.lastPlayback,
      peers: peers.status().map(({ name, online, projects }) => ({ name, online, projects })),
    });
    return;
  }
  res.writeHead(404).end();
});
server.requestTimeout = 0; // approvals are held open until the operator answers
server.headersTimeout = 0;

// ---- WebSocket ----
const wss = new WebSocketServer({ server, path: '/radio', maxPayload: 1 << 20 });
wss.on('connection', (ws, req) => {
  const addr = req.socket.remoteAddress;
  if (!allowed(addr, config.allow)) { ws.close(4403, 'not allowed'); return; }
  ws.authed = false;
  ws.speaker = false;
  ws.isAlive = true;
  clients.add(ws);
  ws.on('pong', () => { ws.isAlive = true; });

  const welcome = (hello) => {
    ws.authed = true;
    ws.role = hello.role === 'radio' ? 'radio' : 'desk';
    send(ws, { type: 'welcome', voice: pack.voice ?? {}, speech: stt.ready, interrupt: pack.commands.interrupt?.[0] });
    send(ws, { type: 'history', events: history });
    send(ws, { type: 'state', state: radio.snapshot() });
    // Greet a fresh session; stay quiet on a reconnect after a dropout.
    if (!hello.reconnect) {
      const greeting = { type: 'say', id: 0, text: radio.greeting(), rich: radio.greeting() };
      send(ws, ws.role === 'radio' ? withVoice(greeting) : greeting);
    }
  };

  // This machine's own browser needs no key.
  if (isLoopback(addr) && !new URL(req.url, 'http://x').searchParams.has('wait')) welcome({});

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (!ws.authed || ws.role !== 'radio') return;
      if (micOwner !== ws) { micOwner = ws; stt.reset(); }
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      stats.audioBytes += buf.length;
      stt.audio(buf);
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!ws.authed) {
      if (msg.type === 'hello' && (isLoopback(addr) || sameSecret(msg.token, token))) welcome(msg);
      else ws.close(4401, 'token');
      updateSpeakers();
      return;
    }
    switch (msg.type) {
      case 'hello':
        ws.role = msg.role === 'radio' ? 'radio' : ws.role;
        break;
      case 'heard': // typed
        radio.hear(String(msg.text ?? ''));
        break;
      case 'speaker': // this device plays speech aloud and reports progress
        ws.speaker = Boolean(msg.on);
        updateSpeakers();
        break;
      case 'playback':
        if (Number.isInteger(msg.id) && msg.id > 0) {
          stats.playbackReports += 1;
          stats.lastPlayback = { id: msg.id, state: msg.state, at: msg.at };
          if (radio.userTalking && msg.state === 'start') overlapped = true;
          radio.playback({ id: msg.id, state: msg.state, at: Number(msg.at) || 0 });
        }
        break;
      case 'mic': // the phone stopped or started listening
        if (!msg.on && micOwner === ws) stt.flush();
        break;
      default:
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    if (micOwner === ws) { micOwner = null; stt.flush(); }
    updateSpeakers();
  });
});

// Keep phone connections alive through mobile networks; drop dead ones.
setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* closing */ }
  }
}, 20_000).unref();

const listenArgs = config.host ? [config.port, config.host] : [config.port];
server.listen(...listenArgs, () => {
  const projects = listProjects(config);
  const where = addresses();
  console.log(`Dispatcher on port ${config.port}  (${projects.length} projects: ${projects.map((p) => p.name).join(', ') || 'none'})`);
  if (peers.list.length) console.log(`  Peers:        ${peers.list.map((p) => `${p.name} (${p.url})`).join(', ')}`);
  console.log(`  Desk radio:   http://localhost:${config.port}/`);
  console.log(`  Pair a phone: http://localhost:${config.port}/pair`);
  if (where.tailscale.length) {
    console.log(`  Phone server: ${where.tailscale[0]}:${config.port}  (${where.dns ?? 'Tailscale'})`);
    console.log(`  Phone app:    http://${where.tailscale[0]}:${config.port}/firstmate.apk`);
  }
  else console.log('  Tailscale is not up on this computer; phones can only connect once it is.');
});

process.on('SIGTERM', () => { stt.stop(); voice.stop(); process.exit(0); });
process.on('SIGINT', () => { stt.stop(); voice.stop(); process.exit(0); });

function pairPage({ code, expires, where, port }) {
  const servers = [where.tailscale[0], where.dns].filter(Boolean).map((h) => `${h.includes(':') ? `[${h}]` : h}:${port}`);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bring a phone aboard</title>
<style>
@font-face{font-family:'Pirata One';src:url(/fonts/PirataOne-Regular.ttf) format('truetype');font-display:swap}
@font-face{font-family:'IM Fell English SC';src:url(/fonts/IMFeENsc28P.ttf) format('truetype');font-display:swap}
@font-face{font-family:'Alegreya Sans';src:url(/fonts/AlegreyaSans-Regular.ttf) format('truetype');font-display:swap}
@font-face{font-family:'Alegreya Sans';font-weight:700;src:url(/fonts/AlegreyaSans-Bold.ttf) format('truetype');font-display:swap}
:root{color-scheme:light dark;--bg:#efe4c9;--panel:#fbf4e2;--ink:#2a1f14;--muted:#6e5d45;--line:#d9c7a0;--brass:#8a5f12;--sea:#23625c}
@media (prefers-color-scheme:dark){:root{--bg:#0c1620;--panel:#142331;--ink:#efe4cc;--muted:#a8b3b8;--line:#27394a;--brass:#d8b065;--sea:#6cc3b0}}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 'Alegreya Sans',system-ui,sans-serif}
main{max-width:580px;margin:0 auto;padding:36px 16px}
h1{font:44px/1.05 'Pirata One',Georgia,serif;margin:0;color:var(--brass);letter-spacing:.01em}
.lede{color:var(--muted);font-style:italic;margin:6px 0 0}
section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-top:18px}
h2{font:24px 'Pirata One',Georgia,serif;color:var(--brass);margin:0 0 6px;font-weight:400;letter-spacing:.02em}
.code{font:700 52px/1.1 ui-monospace,monospace;letter-spacing:.14em;color:var(--brass);margin:6px 0}
.mono{font-family:ui-monospace,monospace;font-size:16px;color:var(--sea)}
.muted{color:var(--muted);font-size:15px}
ol{padding-left:22px;margin:10px 0 0}
li{margin:4px 0}
</style></head><body><main>
<h1>Bring a phone aboard</h1>
<p class="lede">One code, one use. The phone keeps its key after that.</p>
<section>
  <h2>Pairing code</h2>
  <div class="code">${esc(code.slice(0, 3))} ${esc(code.slice(3))}</div>
  <div class="muted">Good until ${new Date(expires).toLocaleTimeString()}. Reload this page for a fresh one.</div>
</section>
<section>
  <h2>Server address for the app</h2>
  ${servers.length ? servers.map((s) => `<div class="mono">${esc(s)}</div>`).join('') : '<div>Tailscale is not running on this computer. Start it, then reload.</div>'}
  <ol class="muted">
    <li>Turn on Tailscale on the phone, signed in to the same account.</li>
    <li>No app yet? On the phone, open <span class="mono">http://${esc(servers[0] ?? `this-computer:${port}`)}/firstmate.apk</span> in Chrome and install it.</li>
    <li>Open First Mate, check the server address, and type the code.</li>
  </ol>
</section>
</main></body></html>`;
}
