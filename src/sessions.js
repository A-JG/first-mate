// Recent Claude Code sessions on this computer, per project, read from the
// transcripts Claude Code keeps under ~/.claude. The operator can then say
// "continue the release notes session" and First Mate resumes it.
//
//   ~/.claude/projects/<cwd with every non-alphanumeric as "-">/<id>.jsonl
//       one transcript per session. Lines of interest: "custom-title",
//       "agent-name", "last-prompt", "relocated", "bridge-session" (Remote
//       Control), and the "cwd" field on ordinary messages.
//   ~/.claude/sessions/<pid>.json
//       one file per Claude Code process that is (or was) open: its sessionId,
//       display name and status. A live pid means the session is open right now.
//
// None of this is a documented interface, so everything is read defensively:
// a file that does not parse is skipped, never fatal.
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';

export const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

const HEAD = 16 * 1024;
const TAIL = 256 * 1024;

function readChunk(file, start, length) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const parseLines = (text, dropFirst) => {
  const lines = text.split('\n');
  if (dropFirst) lines.shift(); // cut mid-line
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial or odd line */ }
  }
  return out;
};

const firstText = (msg) => {
  const c = msg?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.find((x) => x.type === 'text' && x.text)?.text ?? '';
  return '';
};

const oneLine = (s, n = 80) => {
  const t = String(s ?? '').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// What one transcript says about its session. Reads only the head and tail,
// since transcripts run to many megabytes.
export function readTranscript(file, dirName) {
  const { size, mtimeMs } = statSync(file);
  const head = parseLines(readChunk(file, 0, Math.min(size, HEAD)), false);
  const tail = size > HEAD ? parseLines(readChunk(file, Math.max(0, size - TAIL), Math.min(size, TAIL)), size > TAIL) : [];
  const all = [...head, ...tail];
  const last = (type, key) => { for (let i = all.length - 1; i >= 0; i--) if (all[i].type === type && all[i][key]) return all[i][key]; return null; };
  const cwds = [last('relocated', 'relocatedCwd'), ...all.map((m) => m.cwd).filter(Boolean).reverse()].filter(Boolean);
  // Resume from the folder the transcript is filed under, or claude will not find it.
  const cwd = cwds.find((c) => encodeCwd(c) === dirName) ?? cwds[0] ?? null;
  const firstUser = head.find((m) => m.type === 'user' && !m.isMeta && firstText(m).trim() && !firstText(m).startsWith('<'));
  return {
    cwd,
    customTitle: last('custom-title', 'customTitle'),
    agentName: last('agent-name', 'agentName'),
    lastPrompt: last('last-prompt', 'lastPrompt'),
    firstPrompt: firstUser ? firstText(firstUser) : null,
    remoteControl: all.some((m) => m.type === 'bridge-session'),
    hasConversation: all.some((m) => m.type === 'user' || m.type === 'assistant'),
    updatedAt: mtimeMs,
    size,
  };
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Sessions open in a running Claude Code process right now, by session id.
export function liveSessions(claudeDir, isAlive = alive) {
  const out = new Map();
  let names = [];
  try { names = readdirSync(join(claudeDir, 'sessions')); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let s;
    try { s = JSON.parse(readFileSync(join(claudeDir, 'sessions', n), 'utf8')); } catch { continue; }
    if (!s?.sessionId || !Number.isInteger(s.pid) || !isAlive(s.pid)) continue;
    out.set(s.sessionId, { pid: s.pid, name: s.name ?? null, status: s.status ?? null, entrypoint: s.entrypoint ?? null });
  }
  return out;
}

const cache = new Map(); // file -> { key, info }

// Recent sessions for the given projects ([{ name, cwd }]), newest first.
//   [{ id, project, cwd, title, updatedAt, live, remoteControl }]
export function listSessions(projects, {
  claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  limit = 30, perProject = 8, maxAgeDays = 30, now = Date.now(), isAlive,
} = {}) {
  const root = join(claudeDir, 'projects');
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return []; }
  const live = liveSessions(claudeDir, isAlive);
  const oldest = now - maxAgeDays * 86400_000;
  const found = [];
  for (const p of projects) {
    if (!p.cwd) continue;
    const base = encodeCwd(p.cwd);
    const inProject = (cwd) => cwd === p.cwd || cwd.startsWith(p.cwd + sep);
    const files = [];
    // The project folder itself and its worktrees (".claude/worktrees/x" encodes as "--claude-worktrees-x").
    for (const d of dirs) {
      if (d !== base && !d.startsWith(`${base}-`)) continue;
      let entries = [];
      try { entries = readdirSync(join(root, d)); } catch { continue; }
      for (const e of entries) {
        if (!e.endsWith('.jsonl')) continue;
        const file = join(root, d, e);
        try {
          const st = statSync(file);
          if (st.isFile() && st.mtimeMs >= oldest) files.push({ file, dir: d, id: e.slice(0, -6), st });
        } catch { /* vanished */ }
      }
    }
    files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    let kept = 0;
    for (const f of files) {
      if (kept >= perProject) break;
      const key = `${f.st.mtimeMs}:${f.st.size}`;
      let info = cache.get(f.file)?.key === key ? cache.get(f.file).info : null;
      if (!info) {
        try { info = readTranscript(f.file, f.dir); } catch { continue; }
        cache.set(f.file, { key, info });
      }
      // "first-mate" must not pick up "first-mate-two": check the real folder.
      if (!info.cwd || !inProject(info.cwd) || !info.hasConversation) continue;
      const l = live.get(f.id);
      const title = oneLine(l?.name || info.customTitle || info.agentName || info.firstPrompt || info.lastPrompt || 'untitled session', 60);
      found.push({
        id: f.id, project: p.name, cwd: info.cwd, title, updatedAt: Math.round(info.updatedAt),
        live: Boolean(l), status: l?.status ?? null, remoteControl: info.remoteControl,
      });
      kept += 1;
    }
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
