import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Peers, TurnHost, peerRoutes, peerUrl, slimEvent } from '../src/peers.js';
import { listSessions, encodeCwd } from '../src/sessions.js';
import { Pairing, sameSecret } from '../src/net.js';
import { Store } from '../src/store.js';
import { Agents } from '../src/agents.js';
import { Radio } from '../src/radio.js';

const quiet = () => {};
const tmp = () => mkdtempSync(join(tmpdir(), 'firstmate-peer-'));
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => res(b)); });

// A stand-in for a peer's dispatcher: the real peer routes, a key check, and
// scripted agent turns that finish when the test says so.
async function fakePeer({ token = 'k'.repeat(32), projects = [{ name: 'release notes', cwd: '/laptop/Projects/release notes', spoken: 'release notes' }] } = {}) {
  const turns = [];
  const host = new TurnHost({
    run: (t) => new Promise((resolve) => {
      turns.push({ ...t, finish: (text) => resolve({ ok: true, text, sessionId: t.fork ? 'forked-id' : t.sessionId }) });
    }),
  });
  const pairing = new Pairing();
  const routes = peerRoutes({
    host,
    info: () => ({ name: 'laptop', projects, sessions: [{ id: 's-1', project: 'release notes', cwd: '/laptop/Projects/release notes', title: 'Resume release notes', updatedAt: 1, live: true }] }),
    prepare: (b) => {
      if (!projects.some((p) => p.name === b.project)) throw new Error(`There is no project called ${b.project} here.`);
      return b;
    },
    pingMs: 50,
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/pair') {
      const b = JSON.parse(await readBody(req));
      if (!pairing.redeem(b.code)) { res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"That code is wrong or has expired."}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token }));
      return;
    }
    if (!sameSecret(req.headers['x-firstmate-token'], token)) { res.writeHead(401).end(); return; }
    if (!(await routes(req, res, url, readBody))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(cond(), 'timed out'); };
  return { server, url, token, turns, host, pairing, close, until };
}

test('peer addresses: a Tailscale name gets http and the dispatcher port', () => {
  assert.equal(peerUrl('laptop'), 'http://laptop:7373');
  assert.equal(peerUrl('laptop:7400'), 'http://laptop:7400');
  assert.equal(peerUrl('https://laptop.tail1234.ts.net/'), 'https://laptop.tail1234.ts.net');
  assert.equal(peerUrl('100.101.102.103'), 'http://100.101.102.103:7373');
});

test("a peer's projects and sessions appear under names that say where they live", async () => {
  const peer = await fakePeer();
  try {
    const peers = new Peers({ peers: [{ name: 'Laptop', url: peer.url, token: peer.token }], log: quiet });
    assert.equal(await peers.refresh(), true, 'a new peer is a change');
    assert.equal(await peers.refresh(), false, 'the same again is not');
    assert.deepEqual(peers.projects(), [{
      name: 'release notes@laptop', spoken: 'release notes on Laptop', cwd: '/laptop/Projects/release notes',
      host: 'Laptop', remote: 'release notes', online: true,
    }]);
    const [s] = peers.sessions();
    assert.equal(s.project, 'release notes@laptop');
    assert.equal(s.host, 'Laptop');
    assert.equal(s.live, true);
    assert.equal(peers.status()[0].online, true);
  } finally { await peer.close(); }
});

test('a laptop that stops answering keeps its last known projects, marked offline', async () => {
  const peer = await fakePeer();
  const peers = new Peers({ peers: [{ name: 'laptop', url: peer.url, token: peer.token }], log: quiet });
  await peers.refresh();
  await peer.close();
  await peers.refresh();
  assert.equal(peers.projects().length, 1);
  assert.equal(peers.projects()[0].online, false);
  assert.equal(peers.status()[0].online, false);
});

test('a turn on a peer streams activity, asks approvals of the hub, and returns the report', async () => {
  const peer = await fakePeer();
  try {
    const peers = new Peers({ peers: [{ name: 'laptop', url: peer.url, token: peer.token }], log: quiet });
    const events = [];
    const asked = [];
    const done = peers.runTurn('Laptop', {
      project: 'release notes', prompt: 'Add a skills table.', sessionId: 'abc', resume: false, model: 'claude-haiku-5-5',
      onEvent: (m) => events.push(m),
      onApproval: async (a) => { asked.push(a); return { allow: true }; },
    });
    await peer.until(() => peer.turns.length === 1);
    const t = peer.turns[0];
    assert.equal(t.prompt, 'Add a skills table.');
    assert.equal(t.model, 'claude-haiku-5-5');
    t.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/skills.md', old_string: 'big' } }] } });
    t.onEvent({ type: 'system', subtype: 'init' }); // not forwarded
    const answer = await peer.host.approval(t.turnId, { toolName: 'Bash', input: { command: 'npm test' } });
    assert.deepEqual(answer, { allow: true, message: undefined });
    assert.deepEqual(asked, [{ toolName: 'Bash', input: { command: 'npm test' } }]);
    t.finish('Done, captain.');
    const res = await done;
    assert.deepEqual(res, { ok: true, text: 'Done, captain.', sessionId: 'abc' });
    assert.deepEqual(events, [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/skills.md' } }] } }]);
  } finally { await peer.close(); }
});

test('a dropped link reattaches and picks up where it left off, without repeats', async () => {
  const peer = await fakePeer();
  try {
    const logged = [];
    const peers = new Peers({ peers: [{ name: 'laptop', url: peer.url, token: peer.token }], log: (l) => logged.push(l), retry: { firstMs: 10, maxMs: 20 } });
    const events = [];
    let approvals = 0;
    const done = peers.runTurn('laptop', {
      project: 'release notes', prompt: 'go',
      onEvent: (m) => events.push(m.message.content[0].text),
      onApproval: async () => { approvals += 1; return { allow: false, message: 'not now' }; },
    });
    await peer.until(() => peer.turns.length === 1);
    const t = peer.turns[0];
    t.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } });
    await peer.until(() => events.length === 1);
    peer.server.closeAllConnections(); // the wifi drops
    t.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } });
    const answer = await peer.host.approval(t.turnId, { toolName: 'Bash', input: {} });
    assert.deepEqual(answer, { allow: false, message: 'not now' });
    t.finish('Report.');
    assert.equal((await done).text, 'Report.');
    assert.deepEqual(events, ['one', 'two']);
    assert.equal(approvals, 1);
    assert.ok(logged.some((l) => /reattaching/.test(l)), 'the link really dropped');
  } finally { await peer.close(); }
});

test('a peer that is down, refuses the key, or does not have the project gives a spoken-friendly error', async () => {
  const peer = await fakePeer();
  try {
    const wrongKey = new Peers({ peers: [{ name: 'laptop', url: peer.url, token: 'nope' }], log: quiet });
    assert.match((await wrongKey.runTurn('laptop', { project: 'release notes', prompt: 'x' })).error, /laptop did not answer: refused the key/);
    const right = new Peers({ peers: [{ name: 'laptop', url: peer.url, token: peer.token }], log: quiet });
    assert.match((await right.runTurn('laptop', { project: 'elsewhere', prompt: 'x' })).error, /no project called elsewhere/);
    assert.match((await right.runTurn('nobody', { project: 'x', prompt: 'x' })).error, /No computer called nobody/);
  } finally { await peer.close(); }
  const gone = new Peers({ peers: [{ name: 'laptop', url: peer.url, token: peer.token }], log: quiet });
  const r = await gone.runTurn('laptop', { project: 'release notes', prompt: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /laptop did not answer/);
});

test('a turn ending while an approval waits denies it, and late answers are refused', async () => {
  const host = new TurnHost({ run: () => new Promise((r) => setTimeout(() => r({ ok: true, text: '' }), 20)) });
  const id = host.start({});
  const waiting = host.approval(id, { toolName: 'Bash', input: {} });
  assert.equal((await waiting).allow, false);
  const [ask] = host.turns.get(id).events.filter((e) => e.type === 'approval');
  assert.equal(host.answer(id, ask.approval.id, true), false);
  assert.deepEqual(slimEvent({ type: 'user' }), null);
});

test('pairing with a peer trades its code for the key and remembers it', async () => {
  const peer = await fakePeer();
  const dir = tmp();
  try {
    const file = join(dir, 'peers.json');
    const peers = new Peers({ file, log: quiet });
    await assert.rejects(peers.pair({ name: 'laptop', url: peer.url, code: '000000' }), /refused the key: That code is wrong/);
    const { code } = peer.pairing.issue();
    const status = await peers.pair({ name: 'laptop', url: peer.url, code: `${code.slice(0, 3)} ${code.slice(3)}` });
    assert.equal(status.online, true);
    assert.equal(status.projects, 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).peers[0].token, peer.token);
    const again = new Peers({ file, log: quiet });
    assert.equal(again.get('Laptop').token, peer.token);
    assert.ok(again.remove('laptop'));
    assert.equal(new Peers({ file, log: quiet }).list.length, 0);
  } finally { await peer.close(); }
});

// ---- sessions on disk ----

function claudeDir() {
  const dir = tmp();
  const projectsRoot = join(dir, 'home/Projects');
  const write = (cwd, id, lines, folder = encodeCwd(cwd)) => {
    mkdirSync(join(dir, 'projects', folder), { recursive: true });
    writeFileSync(join(dir, 'projects', folder, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  };
  const user = (cwd, text) => ({ type: 'user', cwd, message: { role: 'user', content: text } });
  const main = join(projectsRoot, 'release notes');
  const tree = join(main, '.claude/worktrees/skills-table-1a2b3c');
  write(main, '11111111-1111-1111-1111-111111111111', [user(main, 'Help me resume my release notes'), { type: 'custom-title', customTitle: 'Old title' }, { type: 'custom-title', customTitle: 'Resume release notes' }, { type: 'bridge-session', bridgeSessionId: 'cse_1' }]);
  write(tree, '22222222-2222-2222-2222-222222222222', [user(tree, 'Add a skills table to the resume')]);
  // Same prefix, different project: must not be listed under release notes.
  write(join(projectsRoot, 'release notes-two'), '33333333-3333-3333-3333-333333333333', [user(join(projectsRoot, 'release notes-two'), 'unrelated')]);
  // Started elsewhere and moved into the project.
  write(main, '44444444-4444-4444-4444-444444444444', [user('/tmp/scratch', 'Sketch a cover letter'), { type: 'relocated', relocatedCwd: main }]);
  // No conversation yet.
  write(main, '55555555-5555-5555-5555-555555555555', [{ type: 'mode', mode: 'normal' }]);
  mkdirSync(join(dir, 'sessions'));
  writeFileSync(join(dir, 'sessions', '100.json'), JSON.stringify({ pid: 100, sessionId: '11111111-1111-1111-1111-111111111111', name: 'Resume release notes (remote)', status: 'idle' }));
  writeFileSync(join(dir, 'sessions', '200.json'), JSON.stringify({ pid: 200, sessionId: '22222222-2222-2222-2222-222222222222', name: 'dead' }));
  return { dir, main, tree };
}

test('sessions: titles, worktrees, relocations and which ones are open right now', () => {
  const { dir, main, tree } = claudeDir();
  const list = listSessions([{ name: 'release notes', cwd: main }], { claudeDir: dir, isAlive: (pid) => pid === 100 });
  const byId = Object.fromEntries(list.map((s) => [s.id.slice(0, 1), s]));
  assert.deepEqual(Object.keys(byId).sort(), ['1', '2', '4']);
  assert.equal(byId[1].title, 'Resume release notes (remote)', 'a live session goes by its display name');
  assert.equal(byId[1].live, true);
  assert.equal(byId[1].remoteControl, true);
  assert.equal(byId[2].title, 'Add a skills table to the resume');
  assert.equal(byId[2].cwd, tree, 'resumed from its worktree');
  assert.equal(byId[2].live, false, 'its process is gone');
  assert.equal(byId[4].cwd, main, 'resumed from where it was moved to');
  assert.equal(byId[4].title, 'Sketch a cover letter');
  const dead = listSessions([{ name: 'release notes', cwd: main }], { claudeDir: dir, isAlive: () => false });
  assert.equal(dead.find((s) => s.id.startsWith('1')).title, 'Resume release notes', 'then the custom title');
  assert.deepEqual(listSessions([{ name: 'x', cwd: main }], { claudeDir: join(dir, 'missing') }), []);
});

// ---- the radio with a peer project ----

const pack = JSON.parse(readFileSync(new URL('../packs/orchestra.json', import.meta.url), 'utf8'));

function net({ online = true, live = true } = {}) {
  const said = [];
  const turns = [];
  const store = new Store({ callsigns: pack.callsigns });
  let radio;
  const agents = new Agents({
    store,
    onItem: (item) => radio.notify(item),
    runTurn: ({ thread, prompt }) => new Promise((resolve) => {
      turns.push({ thread: { ...thread }, prompt, finish: (text, sessionId = thread.sessionId) => resolve({ ok: true, text, sessionId }) });
    }),
  });
  const remote = { name: 'release notes@laptop', cwd: '/laptop/Projects/release notes', spoken: 'release notes on Laptop', host: 'Laptop', remote: 'release notes', online };
  const session = { id: '11111111-1111-1111-1111-111111111111', title: 'Resume release notes', cwd: '/laptop/Projects/release notes/.claude/worktrees/rc', live, host: 'Laptop' };
  const seen = [];
  radio = new Radio({
    store, agents, pack, config: { vary: false },
    projects: () => [{ name: 'harbor', cwd: '/p/harbor', spoken: 'harbor' }, remote],
    sessions: () => [{ ...session, project: remote.name }],
    route: async ({ text, sessions }) => {
      seen.push(sessions);
      const pick = /session/.test(text);
      return { project: remote, session: pick ? session : null, callsign: null, title: 'task', instruction: `CLEAN: ${text}`, readback: 'Readback.' };
    },
    out: (e) => { if (e.type === 'say') said.push(e.text); },
  });
  const hear = async (...lines) => { for (const l of lines) await radio.hear(l); await new Promise((r) => setImmediate(r)); await radio.chain; };
  return { radio, store, said, turns, seen, hear, last: () => said.at(-1) };
}

test('picking up a session open on another computer warns, then works on a copy there', async () => {
  const n = net();
  const yes = pack.commands.yes[0];
  const end = pack.terminators[0];
  await n.hear(`continue the release notes session and add a skills table, ${end}`);
  assert.equal(n.seen[0].length, 1, 'the router is offered the sessions');
  assert.match(n.last(), /picks up the session "Resume release notes"/);
  assert.match(n.last(), /That session is open on Laptop right now, so \w+ works on a copy of it\./);
  await n.hear(yes);
  assert.equal(n.turns.length, 1);
  const { thread } = n.turns[0];
  assert.equal(thread.host, 'Laptop');
  assert.equal(thread.remote, 'release notes');
  assert.equal(thread.cwd, '/laptop/Projects/release notes/.claude/worktrees/rc');
  assert.equal(thread.sessionId, '11111111-1111-1111-1111-111111111111');
  assert.equal(thread.started, true, 'resumed, not started fresh');
  assert.equal(thread.fork, true, 'branched, because it is open elsewhere');
  // The branch gets its own id; later turns resume that, not the original.
  n.turns[0].finish('Added the table.', '99999999-9999-9999-9999-999999999999');
  await new Promise((r) => setImmediate(r));
  const t = n.store.open[0];
  assert.equal(t.sessionId, '99999999-9999-9999-9999-999999999999');
  assert.equal(t.fork, false);
});

test('a session nobody has open is resumed directly, and a sleeping peer is announced', async () => {
  const n = net({ live: false, online: false });
  await n.hear(`continue the release notes session, ${pack.terminators[0]}`);
  assert.doesNotMatch(n.last(), /open on/);
  assert.match(n.last(), /Laptop is not answering right now/);
  await n.hear(pack.commands.yes[0]);
  assert.equal(n.turns[0].thread.fork, false);
  assert.equal(n.turns[0].thread.started, true);
});

test('a new thread in a peer project starts a fresh session over there', async () => {
  const n = net();
  await n.hear(`add a skills table to release notes, ${pack.terminators[0]}`);
  assert.match(n.last(), /release notes on Laptop/);
  assert.doesNotMatch(n.last(), /open on/);
  await n.hear(pack.commands.yes[0]);
  const { thread } = n.turns[0];
  assert.equal(thread.host, 'Laptop');
  assert.equal(thread.cwd, '/laptop/Projects/release notes');
  assert.equal(thread.started, false);
});

test('claude is resumed, branched or started with the right flags', async () => {
  const { runTurn } = await import('../src/claude.js');
  const dir = tmp();
  // A stand-in claude that prints its arguments as the result.
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: 'result', result: JSON.stringify(process.argv.slice(2)) }));\n`, { mode: 0o755 });
  const flags = async (o) => {
    const args = JSON.parse((await runTurn({ bin, cwd: dir, prompt: 'x', sessionId: 'S', ...o })).text);
    return ['--resume', '--session-id', '--fork-session'].filter((f) => args.includes(f));
  };
  assert.deepEqual(await flags({ resume: false }), ['--session-id']);
  assert.deepEqual(await flags({ resume: true }), ['--resume']);
  assert.deepEqual(await flags({ resume: true, fork: true }), ['--resume', '--fork-session']);
});
