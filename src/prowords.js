// Turns one transcribed utterance into radio procedure: is it a command, does
// it end the transmission, who is it addressed to.

export function normalize(text, pack) {
  let s = ` ${text.toLowerCase()} `;
  for (const [from, to] of Object.entries(pack.mishearings ?? {})) {
    s = s.split(` ${from} `).join(` ${to} `);
  }
  s = s.replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ');
  for (const [from, to] of Object.entries(pack.mishearings ?? {})) {
    s = s.split(` ${from} `).join(` ${to} `);
  }
  return s.trim();
}

// Remove a spoken phrase from the end / start of the original text, keeping the
// casing and punctuation of what remains. Works on whole tokens so that
// "10-4" (one token, two spoken words) is handled.
function stripSuffix(text, phrase, pack) {
  const toks = text.trim().split(/\s+/);
  for (let i = toks.length - 1; i >= 0; i--) {
    const n = normalize(toks.slice(i).join(' '), pack);
    if (n === phrase) return toks.slice(0, i).join(' ').replace(/[\s,;:–-]+$/, '').trim();
    if (n.length > phrase.length) break;
  }
  return text.trim();
}

function stripPrefix(text, phrase, pack) {
  const toks = text.trim().split(/\s+/);
  for (let i = 1; i <= toks.length; i++) {
    const n = normalize(toks.slice(0, i).join(' '), pack);
    if (n === phrase) return toks.slice(i).join(' ').replace(/^[\s,;:.!–-]+/, '').trim();
    if (n.length > phrase.length) break;
  }
  return text.trim();
}

function commandFor(norm, pack) {
  for (const [intent, phrases] of Object.entries(pack.commands)) {
    if (phrases.includes(norm)) return intent;
  }
  return null;
}

// parse("add a test for login, over and out") ->
//   { ended: true, body: "add a test for login", intent: null }
// parse("go ahead") -> { ended: false, body: "go ahead", intent: "next" }
// A plain "over" does not end anything; it may be part of the instruction.
export function parse(text, pack) {
  const norm = normalize(text, pack);
  let ended = false;
  let body = text.trim();
  let bodyNorm = norm;

  for (const t of pack.terminators) {
    if (norm === t || norm.endsWith(` ${t}`)) {
      ended = true;
      bodyNorm = norm.slice(0, norm.length - t.length).trim();
      body = stripSuffix(body, t, pack);
      break;
    }
  }
  // A command may carry a courtesy word: "affirmative, over".
  let cmd = bodyNorm;
  for (const c of pack.courtesy ?? []) {
    if (cmd.endsWith(` ${c}`)) cmd = cmd.slice(0, -c.length).trim();
  }
  return { ended, body, intent: commandFor(cmd, pack) };
}

// Who a finished transmission is for.
//   "Bravo, also add tests"       -> { callsign: "Bravo", rest: "also add tests" }
//   "new traffic, in harbor ..."  -> { newTraffic: true, rest: "in harbor ..." }
//   "new project bird log, ..."   -> { newTraffic: true, create: "project", rest: "bird log, ..." }
//   "new thread, in harbor ..."   -> { newTraffic: true, create: "thread", rest: "in harbor ..." }
//   "negative, use yarn"          -> { leading: "no", rest: "use yarn" }
// `known` adds the callsigns of open threads, so a thread named under an
// older pack can still be addressed.
export function address(body, pack, known = []) {
  let rest = body;
  const lead = (phrases = []) => {
    const norm = normalize(rest, pack);
    const hit = [...phrases]
      .sort((a, b) => b.length - a.length)
      .find((p) => norm === p || norm.startsWith(`${p} `));
    if (hit) rest = stripPrefix(rest, hit, pack);
    return Boolean(hit);
  };
  const newTraffic = lead(pack.newTraffic);
  const create = lead(pack.newProject) ? 'project' : lead(pack.newThread) ? 'thread' : null;
  if (create) return { newTraffic: true, create, rest };
  if (newTraffic) return { newTraffic: true, rest };

  const norm = normalize(body, pack);
  const first = norm.split(' ')[0];
  const callsign = [...pack.callsigns, ...known].find((c) => c.toLowerCase() === first);
  if (callsign && norm.includes(' ')) return { callsign, rest: stripPrefix(body, first, pack) };
  // Only "negative, ..." is treated as a leading answer. A leading "copy" or
  // "roger" is too likely to be the first word of a real instruction.
  if (lead(pack.commands.no)) return { leading: 'no', rest };
  return { rest: body };
}

// If `text` starts with one of `phrases`, return what follows (possibly '');
// otherwise null. "Avast, Kraken, use yarn" -> "Kraken, use yarn".
export function leading(text, phrases = [], pack) {
  const norm = normalize(text, pack);
  const hit = [...phrases].sort((a, b) => b.length - a.length).find((p) => norm === p || norm.startsWith(`${p} `));
  if (!hit) return null;
  return stripPrefix(text, hit, pack);
}

export async function loadPack(path) {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(path, 'utf8'));
}
