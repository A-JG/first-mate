// The link between First Mate dispatchers on different computers.
//
//   phone ── this dispatcher (the hub) ──── Tailscale ────▶ peer dispatcher
//                 radio, backlog, voice                      projects, claude -p
//
// Every computer runs its own dispatcher next to its own projects. The hub is
// the one the phone talks to; it lists the peers' projects beside its own, and
// a thread in a peer's project runs its turns over there. Tool activity,
// approvals and the final report come back over the link, so to the radio a
// remote thread looks like any other.
//
// Peer API (same token as a phone, sent as x-firstmate-token):
//   GET  /peer/info                  { name, projects, sessions }  (its own only, never its peers')
//   POST /peer/turn                  start a turn; streams NDJSON lines:
//                                      { type: 'turn', id }               first line
//                                      { seq, type: 'event', msg }        trimmed stream-json
//                                      { seq, type: 'approval', approval: { id, toolName, input } }
//                                      { seq, type: 'result', result }    last line
//                                      { type: 'ping' }                   keep-alive
//   GET  /peer/turn?id=&after=       reattach after a dropped connection (replays from seq `after`)
//   POST /peer/approve               { turn, id, allow, message }: the operator's answer
import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// "laptop", "laptop:7373" or a full URL.
export function peerUrl(u) {
  let s = String(u ?? '').trim();
  if (!/^https?:\/\//.test(s)) s = `http://${s}`;
  const url = new URL(s);
  if (!url.port && url.protocol === 'http:') url.port = '7373';
  return url.origin;
}

// ---- HTTP client ----
// node:http rather than fetch: a turn can stream for an hour, and fetch's
// default timeouts would cut it off.
//   onLine  given: the body is NDJSON, delivered line by line; resolves at the end.
//   onLine absent: resolves with the parsed JSON body.
export function call(peer, method, path, { body, idleMs = 8000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, peer.url);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'x-firstmate-token': peer.token ?? '' };
    if (data) Object.assign(headers, { 'content-type': 'application/json', 'content-length': data.length });
    const req = lib.request(url, { method, headers }, (res) => {
      res.setEncoding('utf8');
      let text = '';
      let buf = '';
      const ok = res.statusCode === 200;
      res.on('data', (d) => {
        if (!onLine || !ok) { text += d; return; }
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          onLine(msg);
        }
      });
      res.on('end', () => {
        if (!ok) {
          let why = '';
          try { why = JSON.parse(text).error ?? ''; } catch { /* not JSON */ }
          const what = res.statusCode === 401 || res.statusCode === 403 ? 'refused the key' : `answered ${res.statusCode}`;
          const e = new Error(why ? `${what}: ${why}` : what);
          e.status = res.statusCode;
          reject(e);
          return;
        }
        if (onLine) { resolve(); return; }
        try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
      });
      res.on('close', () => { if (!res.complete) reject(new Error('the connection dropped')); });
    });
    req.setTimeout(idleMs, () => req.destroy(new Error('no answer')));
    req.on('error', reject);
    req.end(data);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the hub's side ----
export class Peers {
  // peers: from config.json ([{ name, url, token }]); file: where paired peers are kept.
  constructor({ peers = [], file = null, request = call, log = console.log, retry = {}, streamIdleMs = 60_000 } = {}) {
    this.request = request;
    this.log = log;
    this.file = file;
    this.retry = { firstMs: 2000, maxMs: 30_000, giveUpMs: 15 * 60_000, ...retry };
    this.streamIdleMs = streamIdleMs;
    this.configured = peers;
    this.paired = [];
    if (file && existsSync(file)) {
      try { this.paired = JSON.parse(readFileSync(file, 'utf8')).peers ?? []; } catch { /* start empty */ }
    }
    this.state = new Map(); // slug -> { online, error, projects, sessions, checkedAt, host }
  }

  // Configured peers, with paired ones filling in (or replacing) by name.
  get list() {
    const out = new Map();
    for (const p of [...this.configured, ...this.paired]) {
      if (!p?.name || !p.url) continue;
      out.set(slug(p.name), { ...out.get(slug(p.name)), ...p, url: peerUrl(p.url), slug: slug(p.name) });
    }
    return [...out.values()];
  }

  get(name) { return this.list.find((p) => p.slug === slug(name)) ?? null; }

  // Resolves true when a peer came or went, or its projects changed.
  async refresh() {
    const shape = () => JSON.stringify([...this.state].map(([k, v]) => [k, v.online, v.projects.map((p) => p.name)]));
    const before = shape();
    await Promise.all(this.list.map((p) => this.#check(p)));
    for (const key of this.state.keys()) if (!this.get(key)) this.state.delete(key);
    return shape() !== before;
  }

  async #check(peer) {
    const was = this.state.get(peer.slug);
    try {
      const info = await this.request(peer, 'GET', '/peer/info');
      this.state.set(peer.slug, {
        online: true, error: null, checkedAt: Date.now(), host: info.name ?? null,
        projects: Array.isArray(info.projects) ? info.projects : [],
        sessions: Array.isArray(info.sessions) ? info.sessions : [],
      });
      if (!was?.online) this.log(`Peer ${peer.name} is up (${this.state.get(peer.slug).projects.length} projects).`);
    } catch (e) {
      // Keep what it last said: a laptop asleep still has its projects.
      this.state.set(peer.slug, { projects: [], sessions: [], ...was, online: false, error: e.message, checkedAt: Date.now() });
      if (was?.online !== false) this.log(`Peer ${peer.name} is not answering (${e.message}).`);
    }
  }

  // Peers' projects in the hub's terms: a unique name, and the spoken name says where.
  projects() {
    const out = [];
    for (const peer of this.list) {
      const s = this.state.get(peer.slug);
      for (const p of s?.projects ?? []) {
        if (!p?.name) continue;
        out.push({
          name: `${p.name}@${peer.slug}`, spoken: `${p.spoken ?? p.name} on ${peer.name}`,
          cwd: p.cwd ?? null, host: peer.name, remote: p.name, online: s.online,
        });
      }
    }
    return out;
  }

  sessions() {
    const out = [];
    for (const peer of this.list) {
      const s = this.state.get(peer.slug);
      for (const x of s?.sessions ?? []) {
        if (x?.id && x.project) out.push({ ...x, project: `${x.project}@${peer.slug}`, host: peer.name });
      }
    }
    return out;
  }

  status() {
    return this.list.map((p) => {
      const s = this.state.get(p.slug);
      return { name: p.name, url: p.url, paired: Boolean(p.token), online: s?.online ?? null, error: s?.error ?? null, projects: s?.projects?.length ?? 0, checkedAt: s?.checkedAt ?? null };
    });
  }

  // Trade a pairing code shown on the peer for its key, and remember it.
  async pair({ name, url, code, device }) {
    if (!slug(name)) throw new Error('The peer needs a name.');
    const peer = { name: String(name).trim(), url: peerUrl(url) };
    const { token } = await this.request(peer, 'POST', '/pair', { body: { code, device } });
    if (!token) throw new Error('The peer gave no key.');
    peer.token = token;
    this.paired = [...this.paired.filter((p) => slug(p.name) !== slug(name)), peer];
    this.#save();
    await this.#check(this.get(name));
    return this.status().find((s) => slug(s.name) === slug(name));
  }

  remove(name) {
    const before = this.paired.length;
    this.paired = this.paired.filter((p) => slug(p.name) !== slug(name));
    this.state.delete(slug(name));
    this.#save();
    return this.paired.length < before;
  }

  #save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ peers: this.paired }, null, 2)}\n`, { mode: 0o600 });
  }

  // One agent turn on a peer. Same contract as the local runTurn:
  //   -> { ok, text, error, sessionId }
  // onEvent gets the trimmed stream-json messages; onApproval({ toolName, input })
  // must resolve to { allow, message } once the operator answers.
  async runTurn(host, { onEvent, onApproval, ...turn }) {
    const peer = this.get(host);
    if (!peer) return { ok: false, text: '', error: `No computer called ${host} is set up as a peer.` };
    let id = null;
    let after = 0;
    let result = null;
    let lastContact = Date.now();
    let wait = this.retry.firstMs;
    const asked = new Set();
    const onLine = (m) => {
      lastContact = Date.now();
      if (m.type === 'turn') { id = m.id; return; }
      if (m.seq) { if (m.seq <= after) return; after = m.seq; }
      if (m.type === 'event') onEvent?.(m.msg);
      else if (m.type === 'result') result = m.result;
      else if (m.type === 'approval' && m.approval?.id && !asked.has(m.approval.id)) {
        asked.add(m.approval.id);
        const turnId = id;
        Promise.resolve(onApproval ? onApproval({ toolName: m.approval.toolName, input: m.approval.input }) : { allow: false, message: 'Nobody to ask.' })
          .catch((e) => ({ allow: false, message: e.message }))
          .then((a) => this.#answer(peer, turnId, m.approval.id, a));
      }
    };
    for (;;) {
      const before = lastContact;
      try {
        if (!id) await this.request(peer, 'POST', '/peer/turn', { body: turn, onLine, idleMs: this.streamIdleMs });
        else await this.request(peer, 'GET', `/peer/turn?id=${encodeURIComponent(id)}&after=${after}`, { onLine, idleMs: this.streamIdleMs });
      } catch (e) {
        if (!id) return { ok: false, text: '', error: `${peer.name} did not answer: ${e.message}.` };
        if (e.status === 404) return { ok: false, text: '', error: `${peer.name} lost track of this turn; it may have restarted.` };
        if (e.status === 401 || e.status === 403) return { ok: false, text: '', error: `${peer.name} ${e.message}. Pair it again.` };
        if (Date.now() - lastContact > this.retry.giveUpMs) return { ok: false, text: '', error: `Lost contact with ${peer.name} in the middle of the turn (${e.message}).` };
        this.log(`Link to ${peer.name} dropped (${e.message}); reattaching.`);
      }
      if (result) return result;
      if (!id) return { ok: false, text: '', error: `${peer.name} did not start the turn.` };
      if (lastContact !== before) wait = this.retry.firstMs;
      await sleep(wait);
      wait = Math.min(wait * 2, this.retry.maxMs);
    }
  }

  async #answer(peer, turn, id, { allow, message } = {}) {
    for (let i = 0; i < 6; i++) {
      try {
        await this.request(peer, 'POST', '/peer/approve', { body: { turn, id, allow: Boolean(allow), message: message ?? null } });
        return;
      } catch (e) {
        if (e.status === 404) return; // the turn is over
        await sleep(Math.min(this.retry.firstMs * 2 ** i, this.retry.maxMs));
      }
    }
    this.log(`Could not deliver an approval answer to ${peer.name}.`);
  }
}

// ---- the peer's side ----

// Only what the hub's crew display uses, so the link stays light.
const KEEP_INPUT = ['file_path', 'notebook_path', 'path', 'description', 'pattern', 'url', 'query', 'command'];
export function slimEvent(msg) {
  if (msg?.type !== 'assistant') return null;
  const content = [];
  for (const c of msg.message?.content ?? []) {
    if (c.type === 'tool_use') {
      const input = {};
      for (const k of KEEP_INPUT) if (c.input?.[k] != null) input[k] = String(c.input[k]).slice(0, 300);
      content.push({ type: 'tool_use', name: c.name, input });
    } else if (c.type === 'text' && c.text?.trim()) {
      content.push({ type: 'text', text: c.text.slice(0, 300) });
    }
  }
  return content.length ? { type: 'assistant', message: { content } } : null;
}

// Turns run here on behalf of a hub, buffered so the hub can reattach.
export class TurnHost {
  // run({ turnId, ...turn, onEvent }) -> Promise<{ ok, text, error, sessionId }>
  constructor({ run, keepMs = 60 * 60_000, maxEvents = 400 }) {
    this.run = run;
    this.keepMs = keepMs;
    this.maxEvents = maxEvents;
    this.turns = new Map();
  }

  start(turn) {
    const id = randomUUID();
    const t = { id, events: [], seq: 0, done: false, listeners: new Set(), approvals: new Map() };
    t.push = (e) => {
      const ev = { seq: ++t.seq, ...e };
      t.events.push(ev);
      // Old tool activity can go; approvals and the result never do.
      if (t.events.length > this.maxEvents) {
        const i = t.events.findIndex((x) => x.type === 'event');
        if (i >= 0) t.events.splice(i, 1);
      }
      for (const l of [...t.listeners]) l(ev);
    };
    this.turns.set(id, t);
    Promise.resolve()
      .then(() => this.run({ ...turn, turnId: id, onEvent: (msg) => { const m = slimEvent(msg); if (m) t.push({ type: 'event', msg: m }); } }))
      .catch((e) => ({ ok: false, text: '', error: e.message }))
      .then((result) => {
        for (const resolve of t.approvals.values()) resolve({ allow: false, message: 'The turn ended before the operator answered.' });
        t.approvals.clear();
        t.done = true;
        t.push({ type: 'result', result });
        setTimeout(() => this.turns.delete(id), this.keepMs).unref?.();
      });
    return id;
  }

  // Replays events after `after`, then delivers live ones. Returns an
  // unsubscribe function, or null for an unknown turn.
  follow(id, after, listener) {
    const t = this.turns.get(id);
    if (!t) return null;
    for (const ev of t.events) if (ev.seq > after) listener(ev);
    if (t.done) return () => {};
    t.listeners.add(listener);
    return () => t.listeners.delete(listener);
  }

  // From this machine's approval bridge: ask the hub's operator.
  approval(turnId, { toolName, input }) {
    const t = this.turns.get(turnId);
    if (!t || t.done) return Promise.resolve({ allow: false, message: 'Unknown turn.' });
    const id = randomUUID();
    return new Promise((resolve) => {
      t.approvals.set(id, resolve);
      t.push({ type: 'approval', approval: { id, toolName, input } });
    });
  }

  answer(turnId, id, allow, message) {
    const resolve = this.turns.get(turnId)?.approvals.get(id);
    if (!resolve) return false;
    this.turns.get(turnId).approvals.delete(id);
    resolve({ allow: Boolean(allow), message: message || undefined });
    return true;
  }
}

// The peer API routes. Returns true when it handled the request.
//   info()        -> { name, projects, sessions }
//   prepare(body) -> the turn to run (throws if the request is not acceptable)
export function peerRoutes({ host, info, prepare, pingMs = 15_000 }) {
  const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const stream = (res, id, after) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    res.flushHeaders?.();
    const write = (o) => { if (!res.writableEnded) res.write(`${JSON.stringify(o)}\n`); };
    write({ type: 'turn', id });
    const ping = setInterval(() => write({ type: 'ping' }), pingMs);
    ping.unref?.();
    let stop = () => {};
    const end = () => { clearInterval(ping); stop(); if (!res.writableEnded) res.end(); };
    stop = host.follow(id, after, (ev) => { write(ev); if (ev.type === 'result') setImmediate(end); }) ?? (() => {});
    res.on('close', end);
  };

  return async function handle(req, res, url, readBody) {
    if (!url.pathname.startsWith('/peer/')) return false;
    const body = async () => { try { return JSON.parse(await readBody(req)); } catch { return {}; } };
    if (req.method === 'GET' && url.pathname === '/peer/info') {
      json(res, 200, info());
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/peer/turn') {
      let turn;
      try { turn = prepare(await body()); } catch (e) { json(res, 400, { error: e.message }); return true; }
      stream(res, host.start(turn), 0);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/peer/turn') {
      const id = url.searchParams.get('id');
      if (!host.turns.has(id)) { json(res, 404, { error: 'No such turn.' }); return true; }
      stream(res, id, Number(url.searchParams.get('after')) || 0);
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/peer/approve') {
      const b = await body();
      json(res, host.answer(b.turn, b.id, b.allow, b.message) ? 200 : 404, {});
      return true;
    }
    res.writeHead(404).end();
    return true;
  };
}
