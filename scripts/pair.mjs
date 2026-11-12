// Prints a fresh pairing code from the running dispatcher.
import { readFileSync, existsSync } from 'node:fs';
const cfg = existsSync(new URL('../config.json', import.meta.url)) ? JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')) : {};
const port = Number(process.env.FIRSTMATE_PORT ?? cfg.port ?? 7373);
try {
  const r = await fetch(`http://127.0.0.1:${port}/pair/new`, { method: 'POST' });
  const { code, expires } = await r.json();
  console.log(`Pairing code: ${code.slice(0, 3)} ${code.slice(3)}   (valid until ${new Date(expires).toLocaleTimeString()}, one use)`);
  console.log(`Server address and app download: http://localhost:${port}/pair`);
} catch {
  console.log(`The dispatcher is not running on port ${port}. Start it with: npm start`);
  process.exit(1);
}
