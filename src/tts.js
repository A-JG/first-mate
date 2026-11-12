// Runs the local voice worker (tts/worker.py) and hands its audio to phones.
// If the worker is missing or down, lines go out without audio and the phone
// speaks them with its own built-in voice instead.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export class Voice {
  constructor({ root, voice = {}, onChunk, log = console.log }) {
    this.python = join(root, 'tts/.venv/bin/python');
    this.script = join(root, 'tts/worker.py');
    this.voice = voice;
    this.onChunk = onChunk; // ({ id, seq, last, rate, marks, pcm: Buffer }) => void
    this.log = log;
    this.child = null;
    this.ready = false;
    this.gen = 0;
    this.stopped = false;
    this.failures = 0;
  }

  get installed() { return existsSync(this.python); }

  start() {
    if (!this.installed) {
      this.log('The pirate voice is not installed (npm run setup:voice); phones will use their own voice.');
      return;
    }
    const env = { ...process.env, PYTHONUNBUFFERED: '1', FIRSTMATE_VOICE: JSON.stringify(this.voice) };
    const child = spawn(this.python, ['-I', this.script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'ready') {
        this.ready = true;
        this.failures = 0;
        this.log(`Voice ready (${msg.engine} ${msg.voice}).`);
      } else if (msg.type === 'chunk') {
        this.onChunk({ ...msg, pcm: Buffer.from(msg.pcm, 'base64') });
      } else if (msg.type === 'log') {
        this.log(`voice: ${msg.message}`);
      }
    });
    let errTail = '';
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-1500); });
    child.on('exit', (code) => {
      this.ready = false;
      this.child = null;
      if (this.stopped) return;
      this.failures += 1;
      const wait = Math.min(60, 2 ** this.failures);
      this.log(`Voice stopped (exit ${code}); restarting in ${wait}s.${errTail ? `\n${errTail.trim().split('\n').slice(-2).join('\n')}` : ''}`);
      setTimeout(() => this.start(), wait * 1000);
    });
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
  }

  // voice: optional override for this line ({ blend, pitch, speed }), e.g. a crew member's.
  speak({ id, text, dense, voice }) {
    if (!this.ready) return false;
    this.child.stdin.write(`${JSON.stringify({ id, text, dense: Boolean(dense), gen: this.gen, voice })}\n`);
    return true;
  }

  // Drop everything not yet spoken (the operator said the interrupt word).
  cancel() {
    this.gen += 1;
    if (this.child) this.child.stdin.write(`${JSON.stringify({ cancel: this.gen })}\n`);
  }
}
