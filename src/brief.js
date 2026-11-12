// Turns an agent's written output into something worth hearing.
import { basename } from 'node:path';

// Agents are told (skills/radio-brief) to end each turn with:
//   <radio>
//   headline
//   detail
//   detail
//   ASK: one question
//   </radio>
export function extractBrief(text) {
  const blocks = [...String(text).matchAll(/<radio>([\s\S]*?)<\/radio>/gi)];
  if (blocks.length) {
    const lines = blocks.at(-1)[1].split('\n').map((l) => speakable(l)).filter(Boolean);
    const askLine = lines.find((l) => /^ask\s*:/i.test(l));
    const rest = lines.filter((l) => l !== askLine);
    if (rest.length) {
      return {
        headline: rest[0],
        details: rest.slice(1),
        ask: askLine ? askLine.replace(/^ask\s*:\s*/i, '') : null,
      };
    }
  }
  return fallbackBrief(text);
}

// No radio block: read the first few sentences, cleaned up.
export function fallbackBrief(text) {
  const clean = speakable(String(text).replace(/```[\s\S]*?```/g, ' '));
  const sentences = clean.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return { headline: 'Finished with nothing to report.', details: [], ask: null };
  return { headline: sentences[0], details: sentences.slice(1, 4), ask: null };
}

// Strip what a voice cannot say: markdown, links, paths, long identifiers.
// Backtick pairs survive: they mark technical terms for the screen and are
// removed before anything is spoken.
export function speakable(s) {
  return String(s)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/(?<!\w)(?:~|\.{1,2})?\/(?:[\w.-]+\/)*([\w.-]+)/g, '$1')
    .replace(/(?:[\w.-]+\/)+([\w-]+\.\w{1,5})\b/g, '$1')
    .replace(/[*_#>|]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\b[0-9a-f]{12,}\b/gi, 'an id')
    .replace(/\s+/g, ' ')
    .replace(/`\s*`/g, '')
    .trim()
    // Backticks mark a term for on-screen highlighting; a stray one is noise.
    .replace(/`/g, (m, i, all) => ((all.match(/`/g).length % 2) ? '' : m))
    .replace(/\s+/g, ' ');
}

// One spoken sentence describing what an agent is asking permission to do.
export function describeRequest(toolName, input = {}) {
  if (toolName === 'Bash') {
    // Say what it is for, then which programs run. Raw shell is unlistenable.
    const cmd = String(input.command ?? '').replace(/\s+/g, ' ').trim();
    const steps = cmd.split(/&&|\|\||[;|]/).map((x) => x.trim()).filter(Boolean);
    const programs = [...new Set(steps
      .map((x) => x.replace(/^(?:\w+=\S+\s+)+/, '').split(' '))
      .filter((w) => w[0] !== 'cd')
      .map((w) => basename(w[0]) + (/^(git|npm|pnpm|yarn|docker|cargo|go|uv|pip|pip3|gh|cf|wrangler)$/.test(w[0]) && w[1] && !w[1].startsWith('-') ? ` ${w[1]}` : '')))];
    const why = input.description ? ` ${speakable(input.description)}.` : '';
    const runs = programs.length
      ? `It runs ${programs.slice(0, 3).map((x) => `\`${x}\``).join(', then ')}${programs.length > 3 ? ', and more' : ''}.`
      : '';
    const text = speakable(steps.filter((x) => !x.startsWith('cd ')).join(', then ')).replace(/`/g, '');
    const details = [runs, `In full: \`${text.length > 90 ? text.slice(0, 90) : text}\`${text.length > 90 ? ', and more' : ''}`].filter(Boolean);
    return { summary: `run a command.${why}`, details };
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const file = basename(String(input.file_path ?? input.notebook_path ?? 'a file'));
    return { summary: `change the file ${file}, outside the usual project area.`, details: [] };
  }
  if (toolName === 'Read') {
    return { summary: `read the file ${basename(String(input.file_path ?? ''))}, outside the project.`, details: [] };
  }
  if (toolName === 'WebFetch') {
    let host = 'a website';
    try { host = new URL(input.url).hostname; } catch { /* keep default */ }
    return { summary: `fetch a page from ${host}.`, details: [] };
  }
  if (toolName === 'WebSearch') {
    return { summary: `search the web for ${speakable(input.query ?? 'something')}.`, details: [] };
  }
  if (toolName.startsWith('mcp__')) {
    const [, server, tool] = toolName.split('__');
    return { summary: `use ${speakable(tool ?? '')} from ${speakable(server ?? '')}.`.replace(/\s+/g, ' '), details: [] };
  }
  return { summary: `use the ${toolName} tool.`, details: [] };
}
