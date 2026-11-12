// Thin wrappers around the `claude` CLI in headless (-p) mode.
// Headless mode uses the machine's /login subscription credentials, which is
// why this drives the CLI rather than the API.
import { spawn } from 'node:child_process';

// A dispatcher started from inside another Claude session inherits that
// session's control variables; strip them so child agents start clean.
// ANTHROPIC_API_KEY is dropped because it would take precedence over the
// subscription login.
const KEEP = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']);
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (KEEP.has(k)) { env[k] = v; continue; }
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_')) continue;
    if (k.startsWith('MCP_')) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function run(bin, args, { cwd, input, env, onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      if (!onLine) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (onLine && buf.trim()) onLine(buf.trim());
      resolve({ code, out, err });
    });
    child.stdin.end(input ?? '');
  });
}

// One-shot structured answer from a small model. No tools, no session saved.
export async function askJson({ bin = 'claude', model = 'haiku', system, prompt, schema, cwd }) {
  const args = [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt', system,
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  const { code, out, err } = await run(bin, args, { cwd, input: prompt, env: cleanEnv() });
  let parsed;
  try { parsed = JSON.parse(out); } catch { /* fall through */ }
  if (!parsed) throw new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`);
  const result = Array.isArray(parsed) ? parsed.find((m) => m.type === 'result') : parsed;
  if (!result?.structured_output) {
    throw new Error(`no structured output: ${String(result?.result ?? err).slice(0, 300)}`);
  }
  return result.structured_output;
}

// One agent turn in a project folder. Resolves when the turn ends.
// onEvent receives each stream-json message (tool use, text, etc.).
export async function runTurn({
  bin = 'claude', cwd, prompt, sessionId, resume, fork, model, effort,
  permissionMode = 'acceptEdits', appendSystemPrompt, mcpConfig, permissionTool, allowedTools,
  onEvent, signal,
}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (resume) {
    args.push('--resume', sessionId);
    // A session that is open elsewhere is branched, not written into.
    if (fork) args.push('--fork-session');
  } else if (sessionId) {
    args.push('--session-id', sessionId);
  }
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  if (mcpConfig) args.push('--mcp-config', JSON.stringify(mcpConfig));
  if (permissionTool) args.push('--permission-prompt-tool', permissionTool);
  // Variadic flag: keep it last so it cannot swallow another argument.
  if (allowedTools?.length) args.push('--allowedTools', ...allowedTools);

  let result = null;
  let seenSession = sessionId;
  const { code, err } = await run(bin, args, {
    cwd,
    input: prompt,
    signal,
    // Approvals wait on a human who is out walking; do not time the tool out early.
    env: cleanEnv({ MCP_TOOL_TIMEOUT: String(6 * 60 * 60 * 1000) }),
    onLine: (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.session_id) seenSession = msg.session_id;
      if (msg.type === 'result') result = msg;
      onEvent?.(msg);
    },
  });
  if (!result) {
    return { ok: false, sessionId: seenSession, text: '', error: `claude exited ${code}: ${err.slice(0, 400)}` };
  }
  return {
    ok: !result.is_error,
    sessionId: seenSession,
    text: typeof result.result === 'string' ? result.result : '',
    error: result.is_error ? String(result.result ?? result.subtype) : null,
    denials: result.permission_denials ?? [],
  };
}
