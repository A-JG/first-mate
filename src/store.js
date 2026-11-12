// Threads (one Claude Code session each) and the backlog of things waiting
// for the operator. Kept in one JSON file so a restart loses nothing but
// in-flight turns.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  // crew: optional named characters ({ name, role, ... }); a new thread gets
  // the free crew member whose role fits, then any free one, then plain callsigns.
  constructor({ file, callsigns, crew = [] }) {
    this.file = file;
    this.callsigns = callsigns;
    this.crew = crew;
    this.threads = [];
    this.queue = [];
    if (file) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        this.threads = data.threads ?? [];
        this.queue = data.queue ?? [];
      } catch { /* first run */ }
    }
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ threads: this.threads, queue: this.queue }, null, 2));
    renameSync(tmp, this.file);
  }

  get open() { return this.threads.filter((t) => t.status !== 'closed'); }
  thread(id) { return this.threads.find((t) => t.id === id); }
  byCallsign(cs) {
    return this.open.find((t) => t.callsign.toLowerCase() === String(cs).toLowerCase());
  }

  nextCallsign(role) {
    const used = new Set(this.open.map((t) => t.callsign));
    const free = this.crew.filter((c) => !used.has(c.name));
    const fit = free.find((c) => c.role === role) ?? free[0];
    if (fit) return fit.name;
    for (let round = 1; ; round++) {
      for (const c of this.callsigns) {
        const name = round === 1 ? c : `${c} ${round}`;
        if (!used.has(name)) return name;
      }
    }
  }

  // host: the peer computer the project lives on (null: this one), remote: its
  // name there. session: an existing Claude Code session to pick up
  // ({ id, fork }), instead of starting a fresh one.
  createThread({ project, cwd, title, model, effort, role, callsign, host, remote, session }) {
    const used = new Set(this.open.map((x) => x.callsign));
    const t = {
      id: randomUUID(),
      callsign: callsign && !used.has(callsign) ? callsign : this.nextCallsign(role),
      role: role ?? null,
      project, cwd, title,
      host: host ?? null,
      remote: remote ?? null,
      model: model ?? null, // null: the configured default
      effort: effort ?? null,
      sessionId: session?.id ?? randomUUID(),
      started: Boolean(session?.id),
      fork: Boolean(session?.fork),
      status: 'idle', // idle | running | closed
      lastTool: null,
      inbox: [],
      createdAt: Date.now(),
    };
    this.threads.push(t);
    this.save();
    return t;
  }

  closeThread(id) {
    const t = this.thread(id);
    if (t) t.status = 'closed';
    this.queue = this.queue.filter((i) => i.threadId !== id || i.kind === 'approval');
    this.save();
  }

  enqueue(item) {
    const full = { id: randomUUID(), createdAt: Date.now(), ...item };
    this.queue.push(full);
    this.save();
    return full;
  }

  remove(itemId) {
    this.queue = this.queue.filter((i) => i.id !== itemId);
    this.save();
  }

  toBack(itemId) {
    const i = this.queue.findIndex((x) => x.id === itemId);
    if (i < 0) return;
    const [item] = this.queue.splice(i, 1);
    this.queue.push(item);
    this.save();
  }
}
