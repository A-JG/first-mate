// Runs the local speech-to-text worker (stt/worker.py) and restarts it if it
// dies. Audio in, recognised utterances out.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const frame = (kind, payload = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head.write(kind, 0, 'ascii');
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};

export class SpeechToText {
  constructor({ root, model, onText, onSpeech, onDropped, log = console.log }) {
    this.python = join(root, 'stt/.venv/bin/python');
    this.script = join(root, 'stt/worker.py');
    this.model = model;
    this.onText = onText;
    this.onSpeech = onSpeech ?? (() => {});
    this.onDropped = onDropped ?? (() => {});
    this.pause = null;
    this.log = log;
    this.child = null;
    this.ready = false;
    this.hints = null;
    this.stopped = false;
    this.failures = 0;
  }

  get installed() { return existsSync(this.python); }

  start() {
    if (!this.installed) {
      this.log('Speech recognition is not installed. Run: npm run setup:speech');
      return;
    }
    const env = { ...process.env, PYTHONUNBUFFERED: '1' };
    if (this.model) env.FIRSTMATE_STT_MODEL = this.model;
    const child = spawn(this.python, ['-I', this.script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.ready = false;
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'ready') {
        this.ready = true;
        this.failures = 0;
        this.log(`Speech recognition ready (${msg.model}).`);
        if (this.hints) this.#send('H', Buffer.from(JSON.stringify(this.hints)));
        if (this.pause) this.#send('P', Buffer.from(String(this.pause)));
      } else if (msg.type === 'final') {
        this.log(`   heard in ${msg.ms}ms (${msg.secs}s of speech)`);
        this.onText(msg.text);
      } else if (msg.type === 'speech') {
        this.onSpeech(msg.on);
      } else if (msg.type === 'dropped') {
        this.onDropped(msg.why);
      } else if (msg.type === 'log') {
        this.log(`stt: ${msg.message}`);
      }
    });
    let errTail = '';
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
    child.on('exit', (code) => {
      this.ready = false;
      this.child = null;
      if (this.stopped) return;
      this.failures += 1;
      const wait = Math.min(60, 2 ** this.failures);
      this.log(`Speech recognition stopped (exit ${code}); restarting in ${wait}s.${errTail ? `\n${errTail.trim().split('\n').slice(-3).join('\n')}` : ''}`);
      setTimeout(() => this.start(), wait * 1000);
    });
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
  }

  #send(kind, payload) {
    if (!this.child || !this.ready) return;
    this.child.stdin.write(frame(kind, payload));
  }

  audio(buf) { this.#send('A', buf); }
  flush() { this.#send('F'); }
  reset() { this.#send('R'); }

  // How long a pause ends an utterance, in seconds.
  setPause(seconds) {
    if (seconds === this.pause) return;
    this.pause = seconds;
    this.#send('P', Buffer.from(String(seconds)));
  }

  // Words to prime recognition with: commands, thread names, project names.
  setHints(prompt) {
    this.hints = { prompt };
    this.#send('H', Buffer.from(JSON.stringify(this.hints)));
  }
}

// A short, natural-sounding prompt. Whisper copies the style and spelling of
// its prompt, so this both spells the command words and keeps punctuation.
export function hintPrompt(pack, projects) {
  const firsts = Object.values(pack.commands).map((l) => l[0]);
  const words = [...new Set([...firsts, ...pack.newProject.slice(0, 1), ...pack.newThread.slice(0, 1)])];
  const names = (pack.crew?.length ? pack.crew.map((c) => c.name) : pack.callsigns).slice(0, 8);
  const places = projects.map((p) => p.spoken).slice(0, 12);
  return [
    `Radio log. ${words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('. ')}. ${pack.terminators[0].charAt(0).toUpperCase()}${pack.terminators[0].slice(1)}.`,
    `Crew: ${names.join(', ')}.`,
    places.length ? `Projects: ${places.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}
