// Checks every language pack in packs/, then runs the pirate one end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../src/store.js';
import { Agents } from '../src/agents.js';
import { Radio } from '../src/radio.js';
import { parse, address, normalize } from '../src/prowords.js';
import { LINES } from '../src/lines.js';
import { buildGuide } from '../src/guide.js';

const dir = new URL('../packs/', import.meta.url);
const packs = readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]);
const INTENTS = ['yes', 'no', 'next', 'more', 'repeat', 'skip', 'out', 'sitrep', 'standby', 'radiocheck', 'interrupt', 'resume'];
// Words that turn up in dictated software instructions and must never act.
const EVERYDAY = ['next', 'more', 'continue', 'details', 'repeat', 'skip', 'later', 'copy', 'status', 'resume', 'out',
  'go ahead', 'go on', 'stop', 'cancel', 'yes', 'no', 'okay', 'done', 'back', 'delete', 'run', 'test', 'over'];
const OPENERS = ['New project idea for the header', 'New thread pool settings', 'Set the sail colour to blue',
  'Copy the file to backup', 'Next add a footer', 'Status page needs a header'];

for (const [name, pack] of packs) {
  test(`pack ${name}: complete, unambiguous and safe`, () => {
    for (const i of INTENTS) assert.ok(pack.commands[i]?.length, `missing command "${i}"`);
    assert.ok(pack.terminators.length && pack.newProject.length && pack.newThread.length);

    // Every phrase is written the way it is matched, and means one thing only.
    const owner = new Map();
    const lists = { ...pack.commands, terminators: pack.terminators, newProject: pack.newProject, newThread: pack.newThread, newTraffic: pack.newTraffic };
    for (const [intent, phrases] of Object.entries(lists)) {
      for (const p of phrases) {
        assert.equal(normalize(p, pack), p, `"${p}" should be written in matched form`);
        assert.ok(!owner.has(p), `"${p}" is in both ${owner.get(p)} and ${intent}`);
        owner.set(p, intent);
      }
    }
    for (const [intent, phrases] of Object.entries(pack.commands)) {
      for (const p of phrases) assert.equal(parse(p, pack).intent, intent, p);
    }

    // Thread names are single spoken words that are not themselves commands.
    assert.equal(new Set(pack.callsigns).size, pack.callsigns.length);
    for (const c of [...pack.callsigns, ...(pack.crew ?? []).map((m) => m.name)]) {
      assert.match(c, /^[A-Za-z]+$/, c);
      assert.ok(!owner.has(c.toLowerCase()), `${c} is also a command`);
    }

    for (const w of EVERYDAY) assert.equal(parse(w, pack).intent, null, `"${w}" must not be a command`);
    for (const w of OPENERS) assert.deepEqual(address(w, pack), { rest: w }, w);

    // The on-screen guide explains every term, in this pack's own words.
    const guide = buildGuide(pack);
    assert.equal(guide.length, 16);
    for (const g of guide) assert.ok(g.term && g.meaning, g.key);
    assert.equal(guide.find((g) => g.key === 'yes').term, pack.commands.yes[0]);

    // The dispatcher must never say its own interrupt word: an earbud mic
    // picking it up would stop the dispatcher mid-sentence.
    const stopWords = [...pack.commands.interrupt, pack.terminators[0]];
    for (const [key, value] of Object.entries({ ...LINES, ...(pack.lines ?? {}) })) {
      for (const tpl of [].concat(value)) {
        for (const w of stopWords) assert.ok(!` ${normalize(tpl, pack)} `.includes(` ${w} `), `line "${key}" says "${w}"`);
      }
    }

    // Line overrides only use known lines and known placeholders.
    for (const [key, value] of Object.entries(pack.lines ?? {})) {
      assert.ok(key in LINES, `unknown line "${key}"`);
      const known = new Set([...(String(LINES[key]).match(/\{\w+\}/g) ?? []), '{yes}', '{no}', '{next}', '{more}', '{Yes}', '{More}', '{end}', '{yesNo}', '{crew}']);
      for (const tpl of [].concat(value)) {
        for (const ph of tpl.match(/\{\w+\}/g) ?? []) assert.ok(known.has(ph), `line "${key}" uses ${ph}`);
      }
    }
  });
}

test('pirate: a full exchange in pirate speak', async () => {
  const pack = Object.fromEntries(packs).pirate;
  const said = [];
  const turns = [];
  const created = [];
  const projects = [{ name: 'harbor', cwd: '/p/harbor', spoken: 'harbor' }];
  const store = new Store({ callsigns: pack.callsigns, crew: pack.crew });
  let radio;
  const agents = new Agents({
    store,
    onItem: (item) => radio.notify(item),
    runTurn: ({ thread, prompt }) => new Promise((resolve) => {
      turns.push({ thread, prompt, finish: (text) => resolve({ ok: true, text, sessionId: thread.sessionId }) });
    }),
  });
  radio = new Radio({
    store, agents, pack, projects: () => projects, config: { vary: false },
    createProject: (p) => created.push(p.name),
    route: async ({ text, create }) => ({
      project: create === 'project' ? { name: 'bird-log', cwd: '/p/bird-log', spoken: 'bird log', isNew: true } : projects[0],
      callsign: null, title: 't', instruction: text, readback: 'Readback.',
    }),
    out: (e) => { if (e.type === 'say') said.push(e.text); },
  });
  const settle = async () => { await new Promise((r) => setImmediate(r)); await radio.chain; };
  const hear = async (...lines) => { for (const l of lines) await radio.hear(l); await settle(); };
  const last = () => said.at(-1);

  assert.equal(radio.greeting(), 'Ahoy, captain. All quiet on the seas, captain.');
  await hear('Ahoy, matey!');
  assert.equal(last(), 'Ahoy! Loud and clear, captain.');

  await hear('In harbor, copy the status over to the next page and add more details. Over and out.');
  assert.equal(last(), 'Aye. harbor, a job for Bones. Readback. Aye aye, or walk the plank?');
  await hear('Aye aye, captain.');
  assert.equal(last(), 'Aye aye. Bones be on it.');

  await hear('Maiden voyage. Call it bird log and track sightings, over and out.');
  assert.equal(last(), 'Aye. A new ship, the bird log, with Flint aboard. Readback. Aye aye, or walk the plank?');
  await hear('Eye, eye.');
  assert.deepEqual(created, ['bird-log']);
  assert.equal(last(), 'Aye aye. Flint be on it.');

  await hear("Crow's nest.");
  assert.equal(last(), '2 at the oars: Bones on harbor, Flint on bird log.');

  turns[0].finish('<radio>\nDone. The status moved.\nIt sits at the top now.\n</radio>');
  await settle();
  assert.equal(last(), 'Bones be back with news.');
  await hear('Parley.');
  assert.equal(last(), 'Bones, harbor. Done. The status moved. More grog for more.');
  await hear('More grog!');
  assert.equal(last(), 'It sits at the top now.');
  await hear('Parrot!');
  assert.equal(last(), 'It sits at the top now.');
  await hear('Davy Jones.');
  assert.equal(last(), 'Bones rests with Davy Jones.');

  const ask = agents.requestApproval({ threadId: turns[1].thread.id, toolName: 'Bash', input: { command: 'npm publish', description: 'Publish the package' } });
  await settle();
  assert.equal(last(), 'Flint awaits yer word.');
  await hear('parley');
  assert.equal(last(), 'Flint, bird log. Asks leave to run a command. Publish the package. Aye aye, or walk the plank?');
  await hear('Belay that, do not publish anything. Over and out.');
  assert.deepEqual(await ask, { allow: false, message: 'do not publish anything.' });
  assert.equal(last(), 'Flint is denied, with yer orders.');

  await hear('Set sail, in harbor fix the', 'belay that');
  assert.equal(last(), 'Overboard it goes.');
  await hear('drop anchor');
  assert.equal(last(), 'Anchor dropped. Say weigh anchor to sail on.');
  await hear('weigh anchor');
  assert.equal(last(), 'Calm seas. Naught awaits.');
});

test('pirate: wordings vary and never repeat twice running', async () => {
  const pack = Object.fromEntries(packs).pirate;
  const said = [];
  const store = new Store({ callsigns: pack.callsigns });
  const radio = new Radio({ store, agents: new Agents({ store, runTurn: async () => ({ ok: true, text: '' }) }), pack,
    projects: () => [], route: async () => ({}), out: (e) => { if (e.type === 'say') said.push(e.text); } });
  for (let i = 0; i < 30; i++) await radio.hear('ahoy');
  for (let i = 1; i < said.length; i++) assert.notEqual(said[i], said[i - 1]);
  assert.ok(new Set(said).size >= 3, 'several wordings are used');
});

test('pirate crew: the right trade takes the job, and reports speak in that pirate\'s voice', async () => {
  const pack = Object.fromEntries(packs).pirate;
  const store = new Store({ callsigns: pack.callsigns, crew: pack.crew });
  assert.equal(store.nextCallsign('test'), 'Flint');
  assert.equal(store.nextCallsign('write'), 'Quill');
  store.createThread({ project: 'p', cwd: '/p', title: 't', role: 'test' });
  assert.equal(store.nextCallsign('test'), 'Bones', 'Flint is busy, so the next free hand');
  for (const c of pack.crew) {
    assert.ok(c.voice?.blend && c.voice.pitch > 0.7 && c.voice.pitch < 1.05, c.name);
    assert.ok(Object.keys(pack.roles).includes(c.role), c.name);
  }
});

test('pirate: "fire the cannons" sends a transmission, however recognition spells it', async () => {
  const pack = Object.fromEntries(packs).pirate;
  for (const said of ['Fix the footer, fire the cannons.', 'Fix the footer. Fire the cannons!', 'fix the footer fire the canons', 'Fix the footer, fire the cannon.']) {
    const p = parse(said, pack);
    assert.equal(p.ended, true, said);
    assert.match(p.body, /^[Ff]ix the footer[.,]?$/, said);
  }
  assert.equal(parse('Fire the cannons!', pack).ended, true);
  assert.equal(parse('Over and out.', pack).ended, true, 'the old phrase still works');
  assert.equal(parse('fire the cannons when the build is green and then deploy', pack).ended, false, 'only at the end');
});
