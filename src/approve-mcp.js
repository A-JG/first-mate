#!/usr/bin/env node
// Minimal stdio MCP server with one tool, `approve`. Claude Code calls it
// (via --permission-prompt-tool) whenever an agent wants to do something that
// needs the operator's permission. The request is forwarded to the dispatcher,
// which reads it out over the radio and waits for "affirmative" / "negative".
import { createInterface } from 'node:readline';
import { request } from 'node:http';

const URL_BASE = process.env.FIRSTMATE_URL;
const THREAD = process.env.FIRSTMATE_THREAD;
const SECRET = process.env.FIRSTMATE_SECRET;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

const TOOL = {
  name: 'approve',
  description: 'Ask the operator, by voice, whether a tool call may run.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

// node:http rather than fetch: the answer may take an hour, and fetch gives
// up waiting for response headers after five minutes.
function post(path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = request(`${URL_BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'x-firstmate-secret': SECRET ?? '',
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function decide(args) {
  try {
    const body = await post('/internal/approve', { threadId: THREAD, toolName: args.tool_name, input: args.input });
    if (body.allow) return { behavior: 'allow', updatedInput: args.input };
    return { behavior: 'deny', message: body.message || 'The operator said negative.' };
  } catch (e) {
    return { behavior: 'deny', message: `Could not reach the operator (${e.message}). Stop and report.` };
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'firstmate', version: '0.1.0' },
    });
  } else if (method === 'tools/list') {
    reply(id, { tools: [TOOL] });
  } else if (method === 'tools/call') {
    const decision = await decide(params?.arguments ?? {});
    reply(id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
  } else if (method === 'ping') {
    reply(id, {});
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
  }
});
