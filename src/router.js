// Decides where a spoken instruction goes: which project, and whether it
// continues an open thread or starts a new one. Also cleans up the dictation.
import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { askJson } from './claude.js';

const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// Every folder directly under a project root is a project.
export function listProjects(config) {
  const out = [];
  for (const root of config.projectRoots ?? []) {
    const dir = expand(root);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const cwd = join(dir, name);
      try { if (!statSync(cwd).isDirectory()) continue; } catch { continue; }
      out.push({ name, cwd, spoken: config.spokenNames?.[name] ?? name.replace(/[-_]+/g, ' ') });
    }
  }
  for (const p of config.projects ?? []) {
    const cwd = expand(p.path);
    out.push({ name: p.name ?? basename(cwd), cwd, spoken: p.spoken ?? p.name ?? basename(cwd) });
  }
  return out;
}

const SYSTEM = `You are the dispatcher on a voice radio net. The operator is out walking and has dictated an instruction for a software agent. The text came from speech recognition, so expect misheard words, missing punctuation and project names spelled phonetically.

Decide where the instruction goes and restate it.

Rules:
- "project" must be exactly one of the listed project names, chosen by what the operator said. If you cannot tell which project is meant, set "clarify" to one short spoken question and leave "project" empty.
- "thread": if the instruction clearly continues the work of an open thread in that project, give that thread's callsign. Otherwise "new". When unsure, "new".
- "title": three to six words naming the task.
- "instruction": the operator's instruction as clean written text for the agent. Fix recognition errors and punctuation. Keep every requirement. Add nothing, do not solve the task, do not invent details.
- "readback": the instruction boiled down to one spoken sentence of at most twenty words, so the operator can confirm you heard right. Start with the verb. Do not name the project or the thread; that is announced separately. No file paths, symbols or code.
- "session": only if the operator asks to continue, resume, pick up or send to one of the listed Claude Code sessions, named by its title or subject: that session's key (like "s3"). Then "project" is that session's project and "thread" is "new". Otherwise empty.
- "model" and "effort": only if the operator explicitly asked for a particular model ("use Sonnet", "on Haiku") or effort level ("low effort", "think hard" means high, "max effort") for this task; otherwise empty. When set, end the readback with it, for example "on Sonnet, low effort".`;

const NEW_PROJECT = `

The operator has asked to start a brand new project, so none of the listed projects applies. Set "project" to a short name for the new project, two to four plain words taken from what they said (for example "bird log"). If they gave no name, invent nothing: set "clarify" to "What should the new project be called?" and leave "project" empty. Set "thread" to "new". The rest of the dictation is the first instruction for that project; if there is none, make the instruction "Set up the new project." and say so in the readback.`;

const NEW_THREAD = `

The operator has asked for a new thread, so "thread" must be "new" even if an open thread looks related. Do not mention the new thread in the readback; that is announced separately.`;

// Spoken model names to the models they mean.
const MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-2' };

// "2 hours ago", for the router's list of sessions.
export function ago(ms, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 2) return 'just now';
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

const SCHEMA = {
  type: 'object',
  properties: {
    project: { type: 'string' },
    thread: { type: 'string' },
    title: { type: 'string' },
    instruction: { type: 'string' },
    readback: { type: 'string' },
    clarify: { type: 'string' },
    model: { type: 'string', enum: ['', 'opus', 'sonnet', 'haiku', 'fable'] },
    effort: { type: 'string', enum: ['', 'low', 'medium', 'high', 'xhigh', 'max'] },
    session: { type: 'string' },
  },
  required: ['project', 'thread', 'title', 'instruction', 'readback'],
};

export function makeRouter(config, roles = null) {
  const roleList = roles ? Object.entries(roles).map(([k, v]) => `  - "${k}": ${v}`).join('\n') : '';
  const schema = roles
    ? { ...SCHEMA, properties: { ...SCHEMA.properties, role: { type: 'string', enum: Object.keys(roles) } } }
    : SCHEMA;
  const roleRule = roles ? `\n- "role": the kind of work, one of:\n${roleList}` : '';
  return async function route({ text, projects, threads, create, near, sessions = [] }) {
    const projectLines = projects.map((p) => `- ${p.name} (spoken: "${p.spoken}")${p.online === false ? ', computer not answering right now' : ''}`).join('\n');
    // Short keys: a small model copies "s3" faithfully, a UUID less so.
    const keyed = create === 'project' ? [] : sessions.map((x, i) => ({ ...x, key: `s${i + 1}` }));
    const sessionLines = keyed.length
      ? `\n\nRecent Claude Code sessions (only for when the operator asks to continue one):\n${keyed.map((x) => `- ${x.key}: "${x.title}", project ${x.project}, last active ${ago(x.updatedAt)}${x.live ? ', open right now' : ''}`).join('\n')}`
      : '';
    const threadLines = threads.length
      ? threads.map((t) => `- ${t.callsign}: project ${t.project}, task "${t.title}"`).join('\n')
      : '(none)';
    const hint = near ? `\n\nIf the instruction names no project, it is for "${near}".` : '';
    const prompt = `Projects:\n${projectLines}\n\nOpen threads:\n${threadLines}${sessionLines}${hint}\n\nDictated instruction:\n${text}`;
    const r = await askJson({
      bin: config.claudeBin,
      model: config.routerModel ?? 'haiku',
      system: SYSTEM + roleRule + (create === 'project' ? NEW_PROJECT : create === 'thread' ? NEW_THREAD : ''),
      prompt,
      schema,
      cwd: config.dataDir,
    });
    if (create === 'project') {
      const name = slug(r.project ?? '');
      if (!name) return { clarify: r.clarify || 'What should the new project be called?' };
      // Saying "new project" for one that already exists just uses it.
      const existing = projects.find((p) => p.name.toLowerCase() === name);
      const root = expand((config.projectRoots ?? ['~/Projects'])[0]);
      const project = existing ?? { name, cwd: join(root, name), spoken: name.replace(/-/g, ' '), isNew: true };
      return { project, callsign: null, title: r.title, instruction: r.instruction, readback: r.readback, model: MODELS[r.model], effort: r.effort || undefined, role: r.role };
    }
    const session = r.session ? keyed.find((x) => x.key === r.session.trim().toLowerCase()) ?? null : null;
    const project = projects.find((p) => p.name === (session?.project ?? r.project));
    if (!project) {
      return { clarify: r.clarify || 'Which project is that for?' };
    }
    return {
      project,
      session: session ? { id: session.id, title: session.title, cwd: session.cwd, live: session.live, host: session.host ?? null } : null,
      callsign: !create && !session && r.thread && r.thread.toLowerCase() !== 'new' ? r.thread : null,
      title: r.title,
      instruction: r.instruction,
      readback: r.readback,
      model: MODELS[r.model],
      effort: r.effort || undefined,
      role: r.role,
    };
  };
}

// After the operator cuts into a report with the interrupt word, decide what
// their interjection was for.
const SORT_SYSTEM = `The operator was listening to a spoken report from a software agent, interrupted it, and said something. The text came from speech recognition. Decide what they meant:

- "reply": a clarification, correction, answer, question or new instruction for this same agent about this work. This includes "wait, I meant..." and "why did you...".
- "new": a separate task or idea unrelated enough to this work that it should start its own thread.
- "resume": they want the report to carry on, for example "go on", "keep going", "sorry, continue".
- "drop": nothing to act on: a false start, an aside to someone else, or "never mind".

When unsure between "reply" and "new", choose "reply" if it touches the subject of the report.`;

const SORT_SCHEMA = {
  type: 'object',
  properties: { kind: { type: 'string', enum: ['reply', 'new', 'resume', 'drop'] }, why: { type: 'string' } },
  required: ['kind'],
};

export function makeSorter(config) {
  return async function sort({ said, report, heard, unheard, thread }) {
    const prompt = [
      `The agent works on project "${thread?.project ?? 'unknown'}", task "${thread?.title ?? ''}".`,
      `Full report: ${report}`,
      `The operator had heard: "${heard.trim()}"`,
      unheard.trim() ? `Not yet heard: "${unheard.trim()}"` : '',
      `Then they said: "${said}"`,
    ].filter(Boolean).join('\n');
    const r = await askJson({
      bin: config.claudeBin,
      model: config.routerModel ?? 'haiku',
      system: SORT_SYSTEM,
      prompt,
      schema: SORT_SCHEMA,
      cwd: config.dataDir,
    });
    return { kind: ['reply', 'new', 'resume', 'drop'].includes(r.kind) ? r.kind : 'reply' };
  };
}
