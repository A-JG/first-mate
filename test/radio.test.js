import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { Agents } from '../src/agents.js';
import { Radio } from '../src/radio.js';
import { parse, address } from '../src/prowords.js';
import { extractBrief, speakable, describeRequest } from '../src/brief.js';

// Procedure is tested against one fixed pack so that swapping themes never
// breaks these tests; test/packs.test.js checks every pack in packs/.
const pack = JSON.parse(readFileSync(new URL('../packs/orchestra.json', import.meta.url), 'utf8'));
const PROJECTS = [
  { name: 'recipe-box', cwd: '/p/recipe-box', spoken: 'recipe box' },
  { name: 'harbor', cwd: '/p/harbor', spoken: 'harbor' },
];

// A net with a scripted router and agents whose turns finish when told to.
function net({ autoAdvance = false } = {}) {
  const said = [];
  const tones = [];
  const turns = [];
  const store = new Store({ callsigns: pack.callsigns });
  let radio;
  const agents = new Agents({
    store,
    onItem: (item) => radio.notify(item),
    runTurn: ({ thread, prompt }) => new Promise((resolve) => {
      turns.push({ thread, prompt, finish: (text) => resolve({ ok: true, text, sessionId: thread.sessionId }) });
    }),
  });
  const routed = [];
  const created = [];
  radio = new Radio({
    store, agents, pack, config: { autoAdvance },
    projects: () => PROJECTS,
    createProject: (project) => { created.push(project.cwd); },
    route: async ({ text, create, near }) => {
      routed.push(text);
      if (create === 'project') {
        if (!/bird log/.test(text)) return { clarify: 'What should the new project be called?' };
        const project = { name: 'bird-log', cwd: '/p/bird-log', spoken: 'bird log', isNew: true };
        return { project, callsign: null, title: 'task', instruction: `CLEAN: ${text}`, readback: 'Readback.' };
      }
      if (/somewhere/.test(text) && !/harbor/.test(text)) return { clarify: 'Which project?' };
      const project = /harbor/.test(text) || near === 'harbor' ? PROJECTS[1] : PROJECTS[0];
      // This router always thinks harbor work belongs on an open harbor thread.
      const callsign = store.open.find((t) => t.project === project.name)?.callsign ?? null;
      return { project, callsign: /continue/.test(text) ? callsign : null, title: 'task', instruction: `CLEAN: ${text}`, readback: 'Readback.' };
    },
    out: (e) => { if (e.type === 'say') said.push(e.text); if (e.type === 'tone') tones.push(e.name); },
  });
  const settle = async () => { await new Promise((r) => setImmediate(r)); await radio.chain; };
  const hear = async (...lines) => { for (const l of lines) await radio.hear(l); await settle(); };
  return { radio, store, agents, said, tones, turns, routed, created, hear, settle, last: () => said.at(-1) };
}

test('prowords: terminators, commands and mishearings', () => {
  assert.deepEqual(parse('Add a test for login, over and out.', pack), { ended: true, body: 'Add a test for login', intent: null });
  assert.equal(parse('Segue.', pack).intent, 'next');
  assert.equal(parse('Segway', pack).intent, 'next');
  assert.equal(parse('Bravo, over.', pack).intent, 'yes');
  assert.equal(parse('Bravo, over and out.', pack).intent, 'yes');
  assert.equal(parse('On-core!', pack).intent, 'repeat');
  assert.equal(parse('Role call?', pack).intent, 'sitrep');
  assert.equal(parse('Finale', pack).intent, 'out');
  assert.deepEqual(parse('Over and out.', pack), { ended: true, body: '', intent: null });
  // A plain "over" ends nothing.
  assert.equal(parse('move the header over', pack).ended, false);
  assert.equal(parse('hand it over.', pack).ended, false);
});

test('everyday words are not commands, even alone after a pause', () => {
  for (const w of ['next', 'more', 'continue', 'details', 'repeat', 'skip', 'later', 'copy', 'status', 'resume',
    'out', 'roger', 'go ahead', 'go on', 'stand by', 'cancel that', 'abort', 'confirmed', 'send it']) {
    assert.equal(parse(w, pack).intent, null, w);
  }
  for (const w of ['New project idea for the header', 'New thread pool settings', 'Alpha release notes', 'Echo the result', 'Delta between the two runs']) {
    assert.deepEqual(address(w, pack), { rest: w }, w);
  }
});

test('prowords: addressing', () => {
  assert.deepEqual(address('Viola, also add tests', pack), { callsign: 'Viola', rest: 'also add tests' });
  assert.deepEqual(address('Overture. Call it bird log', pack), { newTraffic: true, create: 'project', rest: 'Call it bird log' });
  assert.deepEqual(address('Debut, in harbor fix the header', pack), { newTraffic: true, create: 'thread', rest: 'In harbor fix the header'.replace('In', 'in') });
  assert.deepEqual(address('Veto, use yarn instead', pack), { leading: 'no', rest: 'use yarn instead' });
  assert.deepEqual(address('copy the file to backup', pack), { rest: 'copy the file to backup' });
  // A thread named under an older pack is still addressable.
  assert.deepEqual(address('Alpha, add tests', pack, ['Alpha']), { callsign: 'Alpha', rest: 'add tests' });
});

test('brief: radio block, fallback, and speakable text', () => {
  const b = extractBrief('Long written answer.\n<radio>\nDone. Export works.\nOne row per expense.\nASK: Shall I commit?\n</radio>');
  assert.deepEqual(b, { headline: 'Done. Export works.', details: ['One row per expense.'], ask: 'Shall I commit?' });
  const f = extractBrief('I changed `src/app/server.js`. Tests pass. See https://example.com/x for more.');
  assert.equal(f.headline, 'I changed `server.js`.', 'backticks stay as on-screen term marks');
  assert.equal(speakable('uses `yarn` and a stray ` tick'), 'uses yarn and a stray tick');
  assert.equal(speakable('either and/or **bold** in ./a/b/c.txt'), 'either and/or bold in c.txt');
  assert.match(describeRequest('Bash', { command: 'npm install', description: 'Install dependencies' }).summary, /run a command\. Install dependencies\./);
});

test('instruction: dictate in pieces, read back, confirm, dispatch', async () => {
  const n = net();
  await n.hear('In recipe box', 'add an export button to the expense report', 'and write a test for it, over and out');
  assert.deepEqual(n.routed, ['In recipe box add an export button to the expense report and write a test for it']);
  assert.equal(n.last(), 'Copy. recipe box, new thread. Readback. Bravo or veto?');
  assert.equal(n.turns.length, 0, 'nothing runs before the operator confirms');
  await n.hear('bravo');
  assert.equal(n.last(), 'Cello copies.');
  assert.equal(n.turns[0].thread.cwd, '/p/recipe-box');
  assert.match(n.turns[0].prompt, /^CLEAN: /);
});

test('instruction: negative scratches it, a correction re-routes it', async () => {
  const n = net();
  await n.hear('do the thing somewhere over and out');
  assert.equal(n.last(), 'Which project?');
  await n.hear('in harbor, over and out');
  assert.match(n.routed[1], /do the thing somewhere\nCorrection from the operator: in harbor/);
  assert.match(n.last(), /^Copy\. harbor, new thread\./);
  await n.hear('veto');
  assert.equal(n.last(), 'Scratched.');
  assert.equal(n.turns.length, 0);
  assert.equal(n.store.threads.length, 0);
});

test('scratch that abandons a half-spoken transmission', async () => {
  const n = net();
  await n.hear('in harbor change the', 'veto');
  assert.equal(n.last(), 'Scratched.');
  assert.equal(n.routed.length, 0);
});

test('backlog: finished threads wait their turn and are never spoken over the operator', async () => {
  const n = net();
  await n.hear('in recipe box do one over and out', 'bravo', 'in harbor do two over and out', 'bravo');
  const [alpha, bravo] = n.turns;

  // Operator starts talking; Viola then Cello finish meanwhile.
  await n.hear('in harbor also');
  const before = n.said.length;
  bravo.finish('<radio>\nDone. Two is finished.\nDetail one.\nDetail two.\n</radio>');
  await n.settle();
  alpha.finish('<radio>\nDone. One is finished.\nASK: Shall I commit?\n</radio>');
  await n.settle();
  assert.equal(n.said.length, before, 'nothing is said while the operator is mid-transmission');
  await n.hear('veto');

  await n.hear('roll call');
  assert.equal(n.last(), '2 waiting for you, Viola first.');

  // First finished, first heard.
  await n.hear('segue');
  assert.equal(n.last(), 'Viola, harbor. Done. Two is finished. Crescendo for more.');
  await n.hear('crescendo');
  assert.equal(n.last(), 'Detail one.');
  await n.hear('encore');
  assert.equal(n.last(), 'Detail one.');
  await n.hear('bravo');
  assert.equal(n.last(), 'Noted. 1 waiting.');

  // Reply to the item on the air goes straight to its thread, same session.
  await n.hear('segue');
  assert.equal(n.last(), 'Cello, recipe box. Done. One is finished. Shall I commit?');
  await n.hear('yes commit it, over and out');
  assert.equal(n.last(), 'Cello copies.');
  assert.equal(n.turns[2].thread.callsign, 'Cello');
  assert.equal(n.turns[2].prompt, 'yes commit it');
  assert.equal(n.store.queue.length, 0);
});

test('backlog: traffic is announced once when the air is clear', async () => {
  const n = net();
  await n.hear('in harbor do two over and out', 'bravo');
  n.turns[0].finish('<radio>\nDone.\n</radio>');
  await n.settle();
  assert.equal(n.last(), 'Cello is ready.');
  assert.ok(n.tones.includes('traffic'));
});

test('stand by holds announcements until go ahead', async () => {
  const n = net();
  await n.hear('in harbor do two over and out', 'bravo', 'intermission');
  n.turns[0].finish('<radio>\nDone.\n</radio>');
  await n.settle();
  assert.equal(n.last(), 'Holding. Say segue to resume.');
  await n.hear('segue');
  assert.equal(n.last(), 'Cello, harbor. Done.');
});

test('approval: read out, affirmative clears, negative with a note denies', async () => {
  const n = net();
  await n.hear('in harbor do two over and out', 'bravo');
  const thread = n.store.threads[0];

  const first = n.agents.requestApproval({ threadId: thread.id, toolName: 'Bash', input: { command: 'npm install', description: 'Install dependencies' } });
  await n.settle();
  await n.hear('segue');
  assert.equal(n.last(), 'Cello, harbor. Requests approval to run a command. Install dependencies. Bravo or veto?');
  await n.hear('bravo');
  assert.deepEqual(await first, { allow: true, message: undefined });
  assert.equal(n.last(), 'Cello is cleared.');

  const second = n.agents.requestApproval({ threadId: thread.id, toolName: 'Bash', input: { command: 'npm publish' } });
  await n.settle();
  await n.hear('segue', 'what does it do, over and out');
  assert.equal(n.last(), 'Cello is waiting on approval. Bravo or veto?');
  await n.hear('veto, do not publish anything, over and out');
  assert.deepEqual(await second, { allow: false, message: 'do not publish anything' });
});

test('addressing a thread by callsign skips the router; out signs a thread off', async () => {
  const n = net();
  await n.hear('in harbor do two over and out', 'bravo');
  n.turns[0].finish('<radio>\nDone.\n</radio>');
  await n.settle();
  await n.hear('Cello, also update the changelog, over and out');
  assert.equal(n.last(), 'For Cello: also update the changelog. Bravo or veto?');
  assert.equal(n.routed.length, 1);
  await n.hear('bravo');
  assert.equal(n.turns[1].prompt, 'also update the changelog');

  await n.hear('segue', 'finale');
  assert.equal(n.last(), 'Cello signed off.');
  assert.equal(n.store.open.length, 0);
  // The callsign is free again.
  await n.hear('in harbor do three over and out', 'bravo');
  assert.equal(n.last(), 'Cello copies.');
});

test('a busy thread receives a follow-up when its turn ends', async () => {
  const n = net();
  await n.hear('in harbor do two over and out', 'bravo', 'Cello, and add tests, over and out', 'bravo');
  assert.equal(n.turns.length, 1);
  n.turns[0].finish('<radio>\nDone.\n</radio>');
  await n.settle();
  assert.equal(n.turns.length, 2);
  assert.equal(n.turns[1].prompt, 'and add tests');
});

test('approval wording: says the purpose and the programs, not raw shell', () => {
  const r = describeRequest('Bash', {
    command: 'cd /home/me/Projects/recipe-box && FOO=1 npm test -- --watch=false | tee out.log',
    description: 'Run the test suite',
  });
  assert.equal(r.summary, 'run a command. Run the test suite.');
  assert.equal(r.details[0], 'It runs `npm test`, then `tee`.');
  assert.doesNotMatch(r.details[1], /Projects|cd /);
});

test('a plain "over" is part of the instruction; only "over and out" sends it', async () => {
  const n = net();
  await n.hear('in harbor move the totals over', 'to the right hand column, over');
  assert.equal(n.routed.length, 0, 'still transmitting');
  await n.hear('and hand the rest over to the footer. Over and out.');
  assert.deepEqual(n.routed, ['in harbor move the totals over to the right hand column, over and hand the rest over to the footer.']);
  await n.hear('bravo, over');
  assert.equal(n.last(), 'Cello copies.');
  // Pieces first, then the terminator on its own.
  await n.hear('in harbor fix the header', 'over and out');
  assert.equal(n.routed[1], 'in harbor fix the header');
  await n.hear('veto', 'over and out');
  assert.equal(n.last(), 'Nothing received.');
});

test('new thread forces a fresh thread even when the router would continue one', async () => {
  const n = net();
  await n.hear('in harbor do two over and out', 'bravo');
  await n.hear('in harbor continue with the footer over and out');
  assert.match(n.last(), /^Copy\. Cello, harbor\./, 'router attaches it to the open thread');
  await n.hear('veto');
  await n.hear('debut, in harbor continue with the footer, over and out');
  assert.match(n.last(), /^Copy\. harbor, new thread\./);
  await n.hear('bravo');
  assert.equal(n.last(), 'Viola copies.');
  assert.equal(n.store.open.length, 2);
});

test('new project: read back, created only on affirmative, first thread starts in it', async () => {
  const n = net();
  await n.hear('Overture.', 'Call it bird log, and set up a page that lists sightings by day. Over and out.');
  assert.equal(n.last(), 'Copy. New project, bird log. Readback. Bravo or veto?');
  assert.deepEqual(n.created, [], 'no folder before confirmation');
  await n.hear('bravo');
  assert.deepEqual(n.created, ['/p/bird-log']);
  assert.equal(n.turns[0].thread.cwd, '/p/bird-log');
  assert.equal(n.last(), 'Cello copies.');
});

test('new project without a name asks for one, and negative creates nothing', async () => {
  const n = net();
  await n.hear('overture, a place for my hiking photos, over and out');
  assert.equal(n.last(), 'What should the new project be called?');
  await n.hear('call it bird log, over and out');
  assert.equal(n.last(), 'Copy. New project, bird log. Readback. Bravo or veto?');
  await n.hear('veto');
  assert.deepEqual(n.created, []);
  assert.equal(n.store.threads.length, 0);
});

test('new project mid-briefing leaves the item on the air in the backlog', async () => {
  const n = net();
  await n.hear('in harbor do two over and out', 'bravo');
  n.turns[0].finish('<radio>\nDone.\n</radio>');
  await n.settle();
  await n.hear('segue', 'overture bird log, track sightings, over and out', 'bravo');
  assert.equal(n.last(), 'Viola copies. 1 waiting.');
  assert.equal(n.turns[1].thread.project, 'bird-log');
});

test('spoken text is plain; the screen copy keeps term marks, and repeat keeps them too', async () => {
  const n = net();
  const events = [];
  const out = n.radio.out;
  n.radio.out = (e) => { events.push(e); out(e); };
  await n.hear('in harbor do two over and out', 'bravo');
  n.turns[0].finish('<radio>\nDone. The `export` button works.\n</radio>');
  await n.settle();
  await n.hear('segue');
  const say = events.filter((e) => e.type === 'say').at(-1);
  assert.equal(say.text, 'Cello, harbor. Done. The export button works.');
  assert.equal(say.rich, 'Cello, harbor. Done. The `export` button works.');
  await n.hear('encore');
  assert.equal(events.filter((e) => e.type === 'say').at(-1).rich, say.rich);
});

// ---- interrupting the dispatcher ----
// A net with a speaking device attached, so talking over is detected.
async function speakingNet(sortKind = 'reply') {
  const n = net();
  const sorts = [];
  n.radio.sort = async (args) => { sorts.push(args); return { kind: sortKind }; };
  n.radio.setSpeakers(1);
  const said = [];
  const out = n.radio.out;
  n.radio.out = (e) => { said.push(e); out(e); };
  await n.hear('in harbor do two over and out', 'bravo');
  n.turns[0].finish('<radio>\nDone. The header is fixed and the footer moved. Tests pass.\nIt uses the `grid` layout.\nASK: Shall I commit?\n</radio>');
  await n.settle();
  await n.hear('segue');
  const line = said.filter((e) => e.type === 'say').at(-1);
  return { ...n, sorts, events: said, line };
}

test('talking over the dispatcher pauses it; echo resumes it, real words cut in', async () => {
  const n = await speakingNet('reply');
  n.radio.playback({ id: n.line.id, state: 'range', at: n.line.text.indexOf('the footer') });
  assert.ok(n.radio.pauseForOperator(), 'paused as soon as the operator starts talking');
  assert.ok(n.events.some((e) => e.type === 'pause'));

  // Its own voice picked up by the mic: carry on where it stopped.
  await n.radio.hear('shall I commit', { voice: true, overlapped: true });
  await n.settle();
  assert.equal(n.events.at(-2).type, 'resume');

  // Noise that came to nothing also resumes.
  n.radio.pauseForOperator();
  await n.radio.dropped();
  assert.ok(n.events.filter((e) => e.type === 'resume').length >= 2);

  // Real words: playback stops, nothing is said until over and out, then the report picks up.
  n.radio.pauseForOperator();
  const said = n.said.length;
  await n.radio.hear('hang on, I wanted the footer', { voice: true, overlapped: true });
  await n.radio.hear('left where it was', { voice: true });
  await n.settle();
  assert.equal(n.said.length, said, 'quiet while the operator is mid-transmission');
  assert.ok(n.events.some((e) => e.type === 'stop'));
  await n.radio.hear('over and out', { voice: true });
  await n.settle();
  assert.match(n.turns.at(-1).prompt, /They had heard up to: "Cello, harbor\. Done\. The header is fixed and"/);
  assert.match(n.turns.at(-1).prompt, /What they said: hang on, I wanted the footer left where it was$/);
  const heard = n.events.filter((e) => e.type === 'heard');
  assert.deepEqual(heard.slice(-3).map((e) => e.join), [false, true, true], 'one bubble on screen');
});

test('interrupt, clarify: the agent is told exactly where it was cut off', async () => {
  const n = await speakingNet('reply');
  const at = n.line.text.indexOf('the footer');
  n.radio.playback({ id: n.line.id, state: 'range', at });
  await n.radio.hear('Tacet.', { voice: true });
  await n.settle();
  assert.ok(n.events.some((e) => e.type === 'stop'), 'playback stopped everywhere');
  assert.equal(n.last(), 'Stopped. Go ahead.');
  await n.radio.hear('I wanted the footer left alone, over and out', { voice: true });
  await n.settle();
  assert.equal(n.sorts.length, 1);
  assert.equal(n.sorts[0].heard, n.line.text.slice(0, at));
  const prompt = n.turns.at(-1).prompt;
  assert.match(prompt, /They had heard up to: "Cello, harbor\. Done\. The header is fixed and"/);
  assert.match(prompt, /They did not hear: "the footer moved\. Tests pass\. Shall I commit\? Crescendo for more\."/);
  assert.match(prompt, /1 further detail line/);
  assert.match(prompt, /What they said: I wanted the footer left alone$/);
  assert.equal(n.last(), 'Cello copies.');
  assert.equal(n.store.queue.length, 0, 'the old report is superseded by the reply');
});

test('interrupt with a new idea: new thread in the same project, then the report resumes', async () => {
  const n = await speakingNet('new');
  n.radio.playback({ id: n.line.id, state: 'range', at: n.line.text.indexOf('Tests') + 2 });
  await n.radio.hear('tacet, we should also add dark mode some day, over and out', { voice: true });
  await n.settle();
  assert.match(n.routed.at(-1), /^we should also add dark mode/);
  assert.equal(n.last(), 'Copy. harbor, new thread. Readback. Bravo or veto?');
  await n.hear('bravo');
  assert.deepEqual(n.said.slice(-2), ['Viola copies.', 'Back to Cello, where I left off. Tests pass. Shall I commit? Crescendo for more.']);
  // The report is back on the air: replies go to Cello again.
  await n.hear('crescendo');
  assert.equal(n.last(), 'It uses the grid layout.');
});

test('interrupt then scratch the side-trip, or say resume: the report picks up', async () => {
  const n = await speakingNet('new');
  n.radio.playback({ id: n.line.id, state: 'range', at: 17 });
  await n.radio.hear('tacet', { voice: true });
  await n.radio.hear('Debut, in harbor rename the footer, over and out', { voice: true });
  await n.settle();
  assert.match(n.last(), /^Copy\. harbor, new thread\./);
  await n.hear('veto');
  assert.deepEqual(n.said.slice(-2), ['Scratched.', 'Back to Cello, where I left off. Done. The header is fixed and the footer moved. Tests pass. Shall I commit? Crescendo for more.']);

  n.radio.playback({ id: n.radio.seq, state: 'start' });
  await n.radio.hear('tacet', { voice: true });
  await n.hear('da capo');
  assert.match(n.last(), /^Back to Cello, where I left off\. Done\./);
  // Cut into the resumed line partway: resume again from that sentence, once.
  const resumed = n.events.filter((e) => e.type === 'say').at(-1);
  n.radio.playback({ id: resumed.id, state: 'range', at: resumed.text.indexOf('Tests') + 1 });
  await n.radio.hear('tacet', { voice: true });
  await n.hear('da capo');
  assert.equal(n.last(), 'Back to Cello, where I left off. Tests pass. Shall I commit? Crescendo for more.');
  await n.hear('da capo');
  assert.equal(n.last(), 'Nothing to resume.');
});

test('interrupt when nothing is playing just stops and listens', async () => {
  const n = net();
  await n.hear('tacet');
  assert.equal(n.last(), 'Stopped. Go ahead.');
  await n.hear('da capo');
  assert.equal(n.last(), 'Nothing to resume.');
});

test('fromSentence keeps technical-term marks balanced', async () => {
  const { fromSentence } = await import('../src/radio.js');
  const rich = 'Done. It uses `grid` and `flex box`. Tests pass.';
  assert.equal(fromSentence(rich, 0), rich);
  assert.equal(fromSentence(rich, 12), 'It uses `grid` and `flex box`. Tests pass.');
  assert.equal(fromSentence(rich, 40), 'Tests pass.');
});

test('its own echo, finished just after it stopped talking, is not acted on', async () => {
  const n = net();
  n.radio.setSpeakers(1);
  await n.hear('encore');
  const before = n.said.length;
  await n.radio.hear('nothing to repeat', { voice: true, overlapped: true });
  await n.settle();
  assert.equal(n.said.length, before);
  await n.radio.hear('tacet', { voice: true, overlapped: true });
  await n.settle();
  assert.equal(n.last(), 'Stopped. Go ahead.');
});

test('announcements wait until the operator stops talking', async () => {
  const n = net();
  await n.hear('in harbor do two over and out', 'bravo');
  n.radio.setUserTalking(true);
  n.turns[0].finish('<radio>\nDone.\n</radio>');
  await n.settle();
  assert.equal(n.last(), 'Cello copies.', 'nothing said over the operator');
  n.radio.setUserTalking(false);
  await n.settle();
  assert.equal(n.last(), 'Cello is ready.');
});
