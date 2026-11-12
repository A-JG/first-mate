// Links this computer's dispatcher to the dispatcher on another computer.
//
//   npm run peer -- add "laptop" laptop 123456
//   npm run peer -- list
//   npm run peer -- remove "laptop"
//
// The code comes from http://localhost:7373/pair (or `npm run pair`) on the
// other computer. Its address can be a Tailscale name, an IP, host:port or a URL.
import { readFileSync, existsSync } from 'node:fs';

const cfg = existsSync(new URL('../config.json', import.meta.url)) ? JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')) : {};
const port = Number(process.env.FIRSTMATE_PORT ?? cfg.port ?? 7373);
const base = `http://127.0.0.1:${port}/peers`;
const [cmd, ...args] = process.argv.slice(2);

const show = (p) => {
  const state = p.online === null ? 'not checked yet' : p.online ? `up, ${p.projects} projects` : `not answering${p.error ? ` (${p.error})` : ''}`;
  console.log(`  ${p.name.padEnd(18)} ${p.url.padEnd(32)} ${p.paired ? '' : '(no key) '}${state}`);
};

try {
  if (cmd === 'add' && args.length >= 3) {
    const [name, url, ...code] = args;
    const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, url, code: code.join('') }) });
    const body = await r.json();
    if (!r.ok) { console.log(`Could not pair: ${body.error}`); process.exit(1); }
    console.log('Paired:');
    show(body.peer);
  } else if (cmd === 'remove' && args.length === 1) {
    const r = await fetch(`${base}?name=${encodeURIComponent(args[0])}`, { method: 'DELETE' });
    console.log(r.ok ? `Removed ${args[0]}.` : `No paired peer called ${args[0]} (peers written in config.json stay until you edit it).`);
  } else if (!cmd || cmd === 'list') {
    const { peers } = await (await fetch(base)).json();
    if (!peers.length) console.log('No peers yet. Add one with: npm run peer -- add "<name>" <address> <code>');
    else peers.forEach(show);
  } else {
    console.log('Usage:\n  npm run peer -- add "<name>" <address> <pairing code>\n  npm run peer -- list\n  npm run peer -- remove "<name>"');
    process.exit(1);
  }
} catch (e) {
  if (e.cause?.code === 'ECONNREFUSED') console.log(`The dispatcher is not running on port ${port}. Start it with: npm start`);
  else console.log(e.message);
  process.exit(1);
}
