// The radio net: a conversation between one operator and many agent threads.
// Finished work waits on the backlog and is handled first come, first served;
// nothing is announced while the operator is talking.
//
//   idle        listening. A transmission here is a new instruction.
//   confirming  an instruction has been read back and awaits yes / no.
//   briefing    one backlog item is on the air; replies go to its thread.
//
// In any mode the operator may be mid-transmission (draft != null): speech
// accumulates until it ends with "over and out". A plain "over" is just a word.
//
// While the dispatcher is speaking, the only thing it listens for is the
// interrupt word ("avast"). That stops playback and remembers where; what the
// operator says next is sorted (a reply to that agent, a new thread, or carry
// on) and the interrupted report picks up again afterwards.
import { parse, address, leading, normalize } from './prowords.js';
import { LINES } from './lines.js';

// Lines heavy with numbers or technical names are read more slowly.
export const isDense = (rich) => /\d/.test(rich) || (rich.match(/`[^`]+`/g) ?? []).length >= 2 || rich.split(/\s+/).length > 24;

// The rich text of `rich` from the start of the sentence containing plain-text
// offset `at`, keeping backtick marks balanced.
export function fromSentence(rich, at) {
  const plain = rich.replace(/`/g, '');
  if (!at || at <= 0) return rich;
  let start = 0;
  const re = /[.!?]\s+/g;
  let m;
  while ((m = re.exec(plain)) && m.index + m[0].length <= at) start = m.index + m[0].length;
  let p = 0;
  let r = 0;
  let ticks = 0;
  while (r < rich.length && p < start) {
    if (rich[r] === '`') ticks += 1; else p += 1;
    r += 1;
  }
  return (ticks % 2 ? '`' : '') + rich.slice(r);
}

const STALE_MS = 45000; // a line nobody reported on is assumed finished after this

export class Radio {
  constructor({ store, agents, route, sort, projects, sessions, createProject, pack, out, config = {} }) {
    this.store = store;
    this.agents = agents;
    this.route = route;
    // sort({ said, report, heard, unheard, thread }) -> { kind: 'reply' | 'new' | 'resume' | 'drop' }
    this.sort = sort ?? (async () => ({ kind: 'reply' }));
    this.projects = projects; // () => [{ name, cwd, spoken, host? }]; host: the peer computer it lives on
    this.sessions = sessions ?? (() => []); // () => recent Claude Code sessions the operator may pick up
    this.createProject = createProject ?? (() => {}); // ({ name, cwd }) => void, makes the folder
    this.pack = pack;
    this.out = out; // (event) => void
    this.config = config;
    this.mode = 'idle';
    this.draft = null;
    this.pending = null;
    this.current = null;
    this.detail = 0;
    this.held = false;
    this.lastSaid = '';
    this.chain = Promise.resolve();
    // Playback tracking, reported by whichever device is doing the speaking.
    this.seq = 0;
    this.lines = [];
    this.doneUpTo = 0;
    this.onAir = null;
    this.speakers = 0;
    this.interrupted = null; // { line, at, itemId }
    this.lastPick = new Map();
    this.userTalking = false; // the recogniser hears the operator right now
    this.heldNotice = null; // an announcement waiting for a gap in the conversation
    this.paused = null; // { line, at }: playback paused because the operator started talking
  }

  // ---- vocabulary ----
  // Everything spoken comes from a line template (src/lines.js, overridable by
  // the pack) filled with the pack's own command words, so swapping the pack
  // changes both what the dispatcher listens for and how it talks.
  #w(intent) { return this.pack.commands[intent]?.[0] ?? intent; }
  #cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  #t(key, vars = {}) {
    const words = {
      yes: this.#w('yes'), no: this.#w('no'), next: this.#w('next'), more: this.#w('more'),
      Yes: this.#cap(this.#w('yes')), More: this.#cap(this.#w('more')),
      end: this.pack.terminators[0],
    };
    const fill = (tpl, v) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
    const line = (k) => this.#pick(k, this.pack.lines?.[k] ?? LINES[k]);
    return fill(line(key), { ...words, yesNo: fill(line('yesNo'), words), ...vars });
  }

  // A line may have several wordings; pick one at random, never the same
  // one twice in a row, so the radio does not sound like a recording.
  #pick(key, options) {
    if (!Array.isArray(options)) return options;
    if (this.config.vary === false || options.length === 1) return options[0];
    let i = Math.floor(Math.random() * options.length);
    if (i === this.lastPick.get(key)) i = (i + 1) % options.length;
    this.lastPick.set(key, i);
    return options[i];
  }

  // ---- output ----
  // `text` is what is spoken; `rich` keeps the backtick marks around technical
  // terms so a screen can highlight them. Each line gets an id so the device
  // speaking it can report progress.
  //   meta.itemId   the backlog item this line reads out (makes it resumable)
  //   meta.overlap  the operator may talk over this line (short acknowledgements)
  //   meta.body     for a resumed line: the report text inside it, and where it starts
  say(rich, meta = {}) {
    const id = ++this.seq;
    const text = rich.replace(/`/g, '');
    this.lastSaid = rich;
    // A report is read in the voice of the crew member who wrote it.
    const item = meta.itemId && this.store.queue.find((i) => i.id === meta.itemId);
    const speaker = meta.speaker ?? (item ? this.store.thread(item.threadId)?.callsign : null) ?? null;
    this.lines.push({ id, rich, text, itemId: meta.itemId ?? null, overlap: Boolean(meta.overlap), body: meta.body ?? null, t: Date.now() });
    if (this.lines.length > 40) this.lines.shift();
    if (!this.speakers) this.doneUpTo = id;
    this.out({ type: 'say', id, text, rich, dense: isDense(rich), speaker });
  }
  tone(name) { this.out({ type: 'tone', name }); }
  emitState() { this.out({ type: 'state', state: this.snapshot() }); }

  snapshot() {
    const cut = this.interrupted && this.store.queue.find((i) => i.id === this.interrupted.itemId);
    return {
      mode: this.mode,
      composing: this.draft ? this.draft.join(' ') : null,
      held: this.held,
      current: this.current?.id ?? null,
      interrupted: cut ? this.#callsign(cut) : null,
      queue: this.store.queue.map((i) => ({
        id: i.id, kind: i.kind, callsign: this.store.thread(i.threadId)?.callsign, headline: i.brief.headline,
      })),
      threads: this.store.open.map((t) => {
        const items = this.store.queue.filter((i) => i.threadId === t.id);
        const member = this.store.crew.find((c) => c.name === t.callsign);
        return {
          callsign: t.callsign, project: t.project, title: t.title, status: t.status, lastTool: t.lastTool,
          activity: t.activity ?? null, since: t.turnStarted ?? null,
          waiting: items.some((i) => i.kind === 'report'), asking: items.some((i) => i.kind === 'approval'),
          squall: items.some((i) => i.kind === 'error'), onAir: items.some((i) => i.id === this.current?.id),
          crew: member ? { title: member.title, role: member.role, color: member.color, look: member.look, personality: member.personality } : null,
        };
      }),
      // The whole crew, aboard or not, for the ship display.
      crew: this.store.crew.map((c) => ({ name: c.name, title: c.title, role: c.role, color: c.color, look: c.look, personality: c.personality })),
    };
  }

  // ---- playback ----
  // The speaking device reports: start / range (at = character offset) / done / stopped.
  playback({ id, state, at = 0 }) {
    if (state === 'start' || state === 'range') {
      this.onAir = { id, at };
      this.doneUpTo = Math.max(this.doneUpTo, id - 1);
    } else if (state === 'done' || state === 'stopped') {
      this.doneUpTo = Math.max(this.doneUpTo, id);
      if (this.onAir && this.onAir.id <= id) this.onAir = null;
      this.#releaseNotice();
    }
  }

  // The operator started talking while the dispatcher was: pause it, and wait
  // to hear what they say. Noise or its own echo resumes playback exactly where
  // it stopped; anything else is the operator cutting in.
  pauseForOperator() {
    if (this.paused || !this.speaking()) return false;
    this.paused = this.#cutPoint() ?? { line: null, at: 0 };
    this.out({ type: 'pause' });
    return true;
  }

  // The recogniser heard nothing worth acting on (too quiet, too unsure).
  dropped() {
    this.chain = this.chain.then(() => { if (this.paused && !this.draft) this.#unpause(); });
    return this.chain;
  }

  #unpause() {
    if (!this.paused) return;
    this.paused = null;
    this.out({ type: 'resume' });
  }

  // The recogniser hears the operator start or stop talking.
  setUserTalking(on) {
    this.userTalking = on;
    if (!on) this.#releaseNotice();
  }

  #releaseNotice() {
    if (!this.heldNotice || this.userTalking || this.speaking()) return;
    const item = this.heldNotice;
    this.heldNotice = null;
    this.notify(item);
  }

  setSpeakers(n) {
    this.speakers = n;
    if (!n) { this.doneUpTo = this.seq; this.onAir = null; }
  }

  speaking() {
    if (!this.speakers) return false;
    const now = Date.now();
    return this.lines.some((l) => l.id > this.doneUpTo && !l.overlap && now - l.t < STALE_MS);
  }

  #cutPoint() {
    const pending = this.lines.filter((l) => l.id > this.doneUpTo);
    if (!pending.length) return null;
    const onAir = this.onAir ? this.lines.find((l) => l.id === this.onAir.id) : null;
    if (onAir?.itemId) return { line: onAir, at: this.onAir.at };
    const itemLine = pending.find((l) => l.itemId);
    if (itemLine) return { line: itemLine, at: 0 };
    return { line: onAir ?? pending[0], at: onAir ? this.onAir.at : 0 };
  }

  // The microphone picked up the dispatcher's own voice.
  #isEcho(text) {
    const heard = normalize(text, this.pack);
    if (!heard) return true;
    const recent = this.lines.slice(-4).map((l) => normalize(l.text, this.pack)).join(' ');
    if (recent.includes(heard)) return true;
    const words = heard.split(' ');
    const vocab = new Set(recent.split(' '));
    const hits = words.filter((w) => vocab.has(w)).length;
    return words.length >= 3 && hits / words.length >= 0.7;
  }

  // ---- input ----
  // One utterance. `voice` is true for speech recognition (subject to the
  // talking-over rule), false for typed text. Utterances are handled in order.
  hear(text, opts = {}) {
    this.chain = this.chain
      .then(() => this.#hear(String(text ?? '').trim(), opts))
      .catch((e) => { this.say(this.#t('error')); console.error(e); })
      .then(() => this.emitState());
    return this.chain;
  }

  // `overlapped`: the utterance began or ran while the dispatcher was speaking.
  async #hear(text, { voice = false, overlapped = false } = {}) {
    if (!text) return;

    const join = Boolean(this.draft); // continues a transmission already under way
    const rest = leading(text, this.pack.commands.interrupt, this.pack);
    if (rest !== null) {
      this.out({ type: 'heard', text, join });
      this.#interrupt(!rest);
      if (!rest) return;
      text = rest;
    } else if (voice && (this.paused || overlapped || this.speaking())) {
      // Its own voice coming back through the mic: carry on as if nothing happened.
      if (this.#isEcho(text)) {
        if (!this.draft) this.#unpause();
        return;
      }
      // The operator is talking: their words win. Playback stops here and the
      // interrupted report picks up once they have said their piece.
      this.out({ type: 'heard', text, join });
      this.#interrupt(false);
    } else {
      this.out({ type: 'heard', text, join });
    }

    const p = parse(text, this.pack);

    // The item on the air can vanish underneath us (an approval whose agent
    // turn ended). Do not let a stale "yes" land on something else.
    if (this.mode === 'briefing' && !this.store.queue.some((i) => i.id === this.current?.id)) {
      this.current = null;
      this.mode = 'idle';
      if (!this.draft && (p.intent === 'yes' || p.intent === 'no')) {
        return this.say(`${this.#t('expired')}${this.#waiting()}`);
      }
    }

    if (this.draft) {
      if (p.intent === 'no' && !p.ended) {
        this.draft = null;
        this.tone('cancel');
        return this.say(this.#t('scratched'));
      }
      if (!p.ended) { this.draft.push(text); return; }
      const full = [...this.draft, p.body].filter(Boolean).join(' ');
      this.draft = null;
      return this.#transmission(full);
    }

    if (p.intent) return this.#command(p.intent);
    if (p.ended) return p.body ? this.#transmission(p.body) : this.say(this.#t('nothingReceived'));
    this.draft = [text];
  }

  // ---- interruption ----
  #interrupt(ack) {
    const cut = this.paused?.line ? this.paused : (this.speaking() ? this.#cutPoint() : null);
    this.paused = null;
    this.out({ type: 'stop' });
    this.doneUpTo = this.seq;
    this.onAir = null;
    const item = cut?.line.itemId && this.store.queue.find((i) => i.id === cut.line.itemId);
    if (item) {
      // A resumed line carries a "back to ..." prefix; remember the report text under it.
      const { body } = cut.line;
      const line = body ? { ...cut.line, rich: body.rich, text: body.rich.replace(/`/g, '') } : cut.line;
      const at = body ? Math.max(0, cut.at - body.offset) : cut.at;
      this.interrupted = { line, at, itemId: item.id };
      this.current = item;
      this.mode = 'briefing';
    }
    this.tone('stop');
    if (ack) this.say(this.#t('interrupted'), { overlap: true });
  }

  #resume() {
    const it = this.interrupted;
    this.interrupted = null;
    const item = it && this.store.queue.find((i) => i.id === it.itemId);
    if (!item) return this.say(this.#t('nothingToResume'));
    this.current = item;
    this.mode = 'briefing';
    const text = fromSentence(it.line.rich, it.at);
    const full = this.#t('resumeFrom', { callsign: this.#callsign(item), text });
    const offset = full.replace(/`/g, '').length - text.replace(/`/g, '').length;
    return this.say(full, { itemId: item.id, body: { rich: text, offset } });
  }

  // After a side-trip (a new thread, a message to another thread) go back to
  // the report that was interrupted.
  #backToReport() {
    if (this.interrupted) return this.#resume();
  }

  // What the agent is told when the operator cut into its report.
  #withContext(said, it, item) {
    const heard = it.line.text.slice(0, it.at).trim();
    const unheard = it.line.text.slice(it.at).trim();
    const later = item.brief.details.slice(this.detail);
    const lines = ['The operator interrupted your spoken report to say something.'];
    lines.push(heard ? `They had heard up to: "${heard}"` : 'They cut in before hearing this line.');
    if (unheard) lines.push(`They did not hear: "${unheard}"`);
    if (later.length) lines.push(`They have not heard ${later.length} further detail line${later.length > 1 ? 's' : ''} of the report.`);
    lines.push('', `What they said: ${said}`);
    return lines.join('\n');
  }

  // ---- commands (a whole utterance that is a proword) ----
  async #command(intent) {
    switch (intent) {
      case 'repeat':
        return this.say(this.lastSaid || this.#t('nothingToRepeat'));
      case 'radiocheck':
        return this.say(this.#t('soundCheck'));
      case 'sitrep':
        return this.say(this.sitrep());
      case 'standby':
        this.held = true;
        return this.say(this.#t('holding'));
      case 'resume':
        return this.#resume();
    }

    if (this.mode === 'confirming') {
      if (intent === 'yes') return this.#dispatch();
      if (intent === 'no') {
        this.pending = null;
        this.mode = 'idle';
        this.tone('cancel');
        this.say(`${this.#t('scratched')}${this.interrupted ? '' : this.#waiting()}`);
        return this.#backToReport();
      }
      return this.say(this.#t('yesNo'));
    }

    // Any other command moves on from an interrupted report.
    this.interrupted = null;

    if (this.mode === 'briefing') {
      const item = this.current;
      const cs = this.#callsign(item);
      if (intent === 'more') {
        const line = item.brief.details[this.detail];
        if (!line) return this.say(this.#t('endOfReport'));
        this.detail += 1;
        return this.say(line, { itemId: item.id });
      }
      if (intent === 'skip') {
        this.store.toBack(item.id);
        this.current = null;
        this.mode = 'idle';
        return this.say(`${this.#t('movedBack', { callsign: cs })}${this.#waiting()}`);
      }
      if (item.kind === 'approval') {
        if (intent === 'yes' || intent === 'no') {
          this.agents.resolveApproval(item.id, intent === 'yes');
          return this.#closeCurrent(this.#t(intent === 'yes' ? 'cleared' : 'denied', { callsign: cs }));
        }
        return this.say(this.#t('yesNo'));
      }
      if (intent === 'yes' || intent === 'next') {
        this.store.remove(item.id);
        return this.#closeCurrent(intent === 'next' ? '' : this.#t('noted'), intent === 'next');
      }
      if (intent === 'out') {
        this.store.closeThread(item.threadId);
        this.store.remove(item.id);
        return this.#closeCurrent(this.#t('signedOff', { callsign: cs }));
      }
      if (intent === 'no') return this.say(this.#t('giveReply', { callsign: cs }));
    }

    // idle
    if (intent === 'next') {
      this.held = false;
      return this.#briefNext();
    }
    return this.say(this.#t(this.store.queue.length ? 'hintNext' : 'nothingWaiting'));
  }

  // ---- a finished transmission ("... over and out") ----
  async #transmission(body) {
    const a = address(body, this.pack, this.store.open.map((t) => t.callsign));

    if (this.mode === 'confirming') {
      const raw = `${this.pending.raw}\nCorrection from the operator: ${body}`;
      return this.#route(raw, this.pending.thread?.callsign, this.pending.create, this.pending.near);
    }

    // A callsign only addresses a thread if that thread exists; otherwise it
    // is just the first word of the instruction.
    const addressed = a.callsign ? this.store.byCallsign(a.callsign) : null;
    const elsewhere = !a.newTraffic && addressed && addressed.id !== this.current?.threadId;

    if (this.mode === 'briefing' && !a.newTraffic && !elsewhere) {
      const item = this.current;
      const cs = this.#callsign(item);
      if (item.kind === 'approval') {
        if (a.leading === 'no') {
          this.interrupted = null;
          this.agents.resolveApproval(item.id, false, a.rest);
          return this.#closeCurrent(this.#t('deniedWithNote', { callsign: cs }));
        }
        return this.say(this.#t('awaitingApproval', { callsign: cs }));
      }
      const thread = this.store.thread(item.threadId);
      const said = addressed ? a.rest : body;
      const it = this.interrupted?.itemId === item.id ? this.interrupted : null;

      if (it) {
        // Cut in on a report: work out what the operator meant.
        this.tone('working');
        let kind = 'reply';
        try {
          ({ kind } = await this.sort({
            said,
            report: [item.brief.headline, item.brief.ask, ...item.brief.details].filter(Boolean).join(' '),
            heard: it.line.text.slice(0, it.at),
            unheard: it.line.text.slice(it.at),
            thread,
          }));
        } catch (e) {
          console.error('sort failed:', e.message);
        }
        if (kind === 'resume' || kind === 'drop') return this.#resume();
        if (kind === 'new') {
          this.current = null;
          return this.#route(said, null, 'thread', thread?.project);
        }
        this.interrupted = null;
        this.store.remove(item.id);
        this.agents.send(thread, this.#withContext(said, it, item));
        this.tone('sent');
        return this.#closeCurrent(this.#t('copies', { callsign: cs }));
      }

      this.store.remove(item.id);
      this.agents.send(thread, said);
      this.tone('sent');
      return this.#closeCurrent(this.#t('copies', { callsign: cs }));
    }

    // New instruction. Leaves any item on the air where it is in the backlog;
    // an interrupted report resumes once this is dispatched or scratched.
    this.current = null;
    if (a.create) return this.#route(a.rest, null, a.create);
    return this.#route(a.newTraffic || addressed ? a.rest : body, addressed?.callsign);
  }

  // create: 'project' = the operator asked for a brand new project (and thread);
  //         'thread'  = force a new thread in whichever project is meant.
  // near:   project to assume when the operator names none.
  async #route(raw, callsign, create = null, near = null) {
    const direct = !create && callsign && this.store.byCallsign(callsign);
    if (direct) {
      this.pending = { raw, thread: direct, instruction: raw };
      this.mode = 'confirming';
      return this.say(this.#t('direct', { callsign: direct.callsign, text: raw }));
    }

    this.tone('working');
    let r;
    try {
      r = await this.route({ text: raw, projects: this.projects(), threads: this.store.open, create, near, sessions: create === 'project' ? [] : this.sessions() });
    } catch (e) {
      console.error('route failed:', e.message);
      this.mode = 'idle';
      this.pending = null;
      this.say(this.#t('routeFailed'));
      return this.#backToReport();
    }
    this.mode = 'confirming';
    if (r.clarify) {
      this.pending = { raw, create, near };
      return this.say(r.clarify);
    }
    const thread = !create && r.callsign ? this.store.byCallsign(r.callsign) : null;
    // Who will take it on: the free crew member whose trade fits the task.
    const crew = thread ? null : this.store.nextCallsign(r.role);
    this.pending = {
      raw, create, near, thread, project: r.project, title: r.title, instruction: r.instruction,
      model: r.model, effort: r.effort, role: r.role, callsign: crew, session: thread ? null : r.session ?? null,
    };
    const { session } = this.pending;
    const host = r.project.host ?? 'this computer';
    const names = { project: r.project.spoken, callsign: thread?.callsign, crew, session: session?.title, host };
    let where = this.#t('whereNewThread', names);
    if (thread) where = this.#t('whereThread', names);
    else if (session) where = this.#t('whereSession', names);
    else if (r.project.isNew) where = this.#t('whereNewProject', names);
    // Picking up a session someone has open would tangle the two transcripts.
    const warnings = [];
    if (session?.live) warnings.push(this.#t('sessionOpen', names));
    if (r.project.online === false) warnings.push(this.#t('peerAsleep', names));
    const readback = [r.readback, ...warnings].join(' ');
    return this.say(this.#t('readback', { where, readback }));
  }

  async #dispatch() {
    const { pending } = this;
    if (!pending.thread && !pending.project) return this.say(this.#t('tellProject'));
    if (!pending.thread && pending.project.isNew) {
      try {
        await this.createProject(pending.project);
      } catch (e) {
        console.error('create project failed:', e.message);
        return this.say(this.#t('createFailed'));
      }
    }
    const { project, session } = pending;
    const thread = pending.thread ?? this.store.createThread({
      project: project.name, cwd: session?.cwd ?? project.cwd, title: session?.title ?? pending.title,
      model: pending.model, effort: pending.effort, role: pending.role, callsign: pending.callsign,
      host: project.host, remote: project.remote,
      session: session && { id: session.id, fork: session.live },
    });
    this.agents.send(thread, pending.instruction);
    this.pending = null;
    this.mode = 'idle';
    this.tone('sent');
    this.say(`${this.#t('copies', { callsign: thread.callsign })}${this.interrupted ? '' : this.#waiting()}`);
    return this.#backToReport();
  }

  // ---- backlog ----
  #callsign(item) { return this.store.thread(item?.threadId)?.callsign ?? 'Unknown'; }

  #waiting() {
    const n = this.store.queue.length;
    if (!n || this.held) return '';
    return ` ${this.#t('waiting', { n })}`;
  }

  #briefNext() {
    const item = this.store.queue[0];
    if (!item) {
      this.current = null;
      this.mode = 'idle';
      return this.say(this.#t('nothingWaiting'));
    }
    const thread = this.store.thread(item.threadId);
    this.current = item;
    this.detail = 0;
    this.mode = 'briefing';
    const who = this.#t('who', { callsign: thread?.callsign ?? 'Unknown', project: this.#spoken(thread) });
    if (item.kind === 'approval') {
      return this.say(this.#t('approval', { who, headline: item.brief.headline }), { itemId: item.id });
    }
    const more = item.brief.details.length ? ` ${this.#t('moreHint')}` : '';
    const ask = item.brief.ask ? ` ${item.brief.ask}` : '';
    return this.say(`${who} ${item.brief.headline}${ask}${more}`, { itemId: item.id });
  }

  #spoken(thread) {
    const p = this.projects().find((x) => x.name === thread?.project);
    return p?.spoken ?? (thread?.project ?? '').replace(/[-_]+/g, ' ');
  }

  #closeCurrent(ack, advance = false) {
    this.current = null;
    this.mode = 'idle';
    if ((advance || this.config.autoAdvance) && this.store.queue.length && !this.held) {
      if (ack) this.say(ack);
      return this.#briefNext();
    }
    const text = `${ack}${this.#waiting()}`.trim();
    return this.say(text || this.#t('nothingMore'));
  }

  // A new backlog item arrived. Only announce it when the air is clear.
  notify(item) {
    this.chain = this.chain.then(() => {
      if (this.userTalking || this.speaking()) {
        if (this.store.queue.some((i) => i.id === item.id)) this.heldNotice = item;
        this.emitState();
        return;
      }
      const clear = this.mode === 'idle' && !this.draft && !this.held;
      if (clear) {
        this.tone('traffic');
        if (this.store.queue.length === 1) this.say(this.#t(item.kind === 'approval' ? 'needsApproval' : 'ready', { callsign: this.#callsign(item) }));
      }
      this.emitState();
    });
    return this.chain;
  }

  greeting() { return this.#t('greeting', { sitrep: this.sitrep() }); }

  sitrep() {
    const running = this.store.open.filter((t) => t.status === 'running');
    const n = this.store.queue.length;
    const parts = [];
    if (running.length) {
      const items = running.map((t) => this.#t('workingItem', { callsign: t.callsign, project: this.#spoken(t) }));
      const names = `${items.slice(0, 3).join(', ')}${items.length > 3 ? this.#t('andOthers') : ''}`;
      parts.push(this.#t('working', { n: running.length, names }));
    }
    if (n) parts.push(this.#t('waitingFor', { n, first: this.#callsign(this.store.queue[0]) }));
    if (this.mode === 'confirming') parts.push(this.#t('awaitingYes'));
    return parts.length ? parts.join(' ') : this.#t('allQuiet');
  }
}
