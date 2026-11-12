// Runs agent turns and files what comes back onto the backlog.
import { basename } from 'node:path';
import { extractBrief, describeRequest } from './brief.js';

// A few plain words on what a tool call is doing, for the crew display.
export function activityOf(name, input = {}) {
  const file = input.file_path ?? input.notebook_path ?? input.path;
  const short = (s, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  if (name === 'Bash') return input.description ? short(input.description) : short(String(input.command ?? '').split(/\s+/).slice(0, 4).join(' '));
  if (file) return basename(String(file));
  if (input.pattern) return short(`"${input.pattern}"`);
  if (input.url) { try { return new URL(input.url).hostname; } catch { return 'a web page'; } }
  if (input.query) return short(`"${input.query}"`);
  if (input.description) return short(String(input.description));
  return '';
}

export class Agents {
  // runTurn({ thread, prompt, onEvent }) -> { ok, text, error, sessionId }
  constructor({ store, runTurn, onItem, onChange }) {
    this.store = store;
    this.runTurn = runTurn;
    this.onItem = onItem ?? (() => {});
    this.onChange = onChange ?? (() => {});
    this.approvals = new Map(); // itemId -> resolve
  }

  // Deliver an instruction. A busy thread gets it when its current turn ends.
  send(thread, text) {
    if (thread.status === 'running') {
      thread.inbox.push(text);
      this.store.save();
      return;
    }
    this.#start(thread, text);
  }

  async #start(thread, prompt) {
    thread.status = 'running';
    thread.lastTool = null;
    thread.activity = { tool: 'thinking', detail: '', since: Date.now() };
    thread.turnStarted = Date.now();
    this.store.save();
    this.onChange();
    let res;
    try {
      res = await this.runTurn({
        thread,
        prompt,
        onEvent: (msg) => {
          if (msg.type !== 'assistant') return;
          for (const c of msg.message?.content ?? []) {
            if (c.type === 'tool_use') {
              thread.lastTool = c.name;
              thread.activity = { tool: c.name, detail: activityOf(c.name, c.input), since: Date.now() };
              this.onChange();
            } else if (c.type === 'text' && c.text?.trim()) {
              thread.activity = { tool: 'thinking', detail: '', since: Date.now() };
            }
          }
        },
      });
    } catch (e) {
      res = { ok: false, text: '', error: e.message };
    }
    this.#dropApprovals(thread.id);
    thread.started = true;
    thread.activity = null;
    if (res.sessionId && res.sessionId !== thread.sessionId) {
      thread.sessionId = res.sessionId;
      thread.fork = false; // a branched session is now this thread's own
    }
    if (thread.status !== 'closed') thread.status = 'idle';

    const brief = res.ok
      ? extractBrief(res.text)
      : { headline: 'The agent stopped with an error.', details: [String(res.error ?? '').slice(0, 200)], ask: null };
    const item = this.store.enqueue({
      kind: res.ok ? 'report' : 'error',
      threadId: thread.id,
      brief,
      full: res.text,
    });
    this.onItem(item);

    if (thread.status === 'idle' && thread.inbox.length) {
      const next = thread.inbox.splice(0).join('\n\n');
      this.#start(thread, next);
    } else {
      this.store.save();
      this.onChange();
    }
  }

  // Called by the approval bridge. Resolves when the operator answers.
  requestApproval({ threadId, toolName, input }) {
    const thread = this.store.thread(threadId);
    if (!thread) return Promise.resolve({ allow: false, message: 'Unknown thread.' });
    const { summary, details } = describeRequest(toolName, input);
    const item = this.store.enqueue({
      kind: 'approval',
      threadId,
      brief: { headline: summary, details, ask: null },
      toolName,
    });
    return new Promise((resolve) => {
      this.approvals.set(item.id, resolve);
      this.onItem(item);
    });
  }

  resolveApproval(itemId, allow, message) {
    const resolve = this.approvals.get(itemId);
    this.approvals.delete(itemId);
    this.store.remove(itemId);
    resolve?.({ allow, message });
  }

  // A turn that has ended cannot still be waiting on an approval.
  #dropApprovals(threadId) {
    for (const item of this.store.queue.filter((i) => i.kind === 'approval' && i.threadId === threadId)) {
      this.resolveApproval(item.id, false, 'The turn ended before the operator answered.');
    }
  }

  // After a restart nothing is actually running or waiting on approval.
  recover() {
    for (const t of this.store.threads) if (t.status === 'running') t.status = 'idle';
    this.store.queue = this.store.queue.filter((i) => i.kind !== 'approval');
    this.store.save();
  }
}
