// Who may talk to the dispatcher, and how a phone gets its key.
import { networkInterfaces } from 'node:os';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const v4 = (addr) => addr.replace(/^::ffff:/, '');

export const isLoopback = (addr = '') => ['127.0.0.1', '::1'].includes(v4(addr)) || v4(addr).startsWith('127.');

// Tailscale hands out 100.64.0.0/10 and fd7a:115c:a1e0::/48.
export function isTailnet(addr = '') {
  const a = v4(addr);
  const m = a.match(/^100\.(\d+)\./);
  if (m) return Number(m[1]) >= 64 && Number(m[1]) <= 127;
  return a.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

export function isLan(addr = '') {
  const a = v4(addr).toLowerCase();
  return /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
    || a.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(a);
}

// allow: "tailscale" (default) or "lan" (tailscale plus the home network).
export function allowed(addr, allow = 'tailscale') {
  if (isLoopback(addr) || isTailnet(addr)) return true;
  return allow === 'lan' && isLan(addr);
}

// This machine's addresses a phone can use.
export function addresses() {
  const out = { tailscale: [], lan: [], dns: null };
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.internal) continue;
      if (isTailnet(i.address)) out.tailscale.push(i.address);
      else if (i.family === 'IPv4' && isLan(i.address)) out.lan.push(i.address);
    }
  }
  try {
    const r = spawnSync('tailscale', ['status', '--self', '--json'], { encoding: 'utf8', timeout: 3000 });
    const name = JSON.parse(r.stdout).Self?.DNSName;
    if (name) out.dns = name.replace(/\.$/, '');
  } catch { /* tailscale CLI not available */ }
  out.tailscale.sort((a, b) => a.includes(':') - b.includes(':'));
  return out;
}

// One long-lived key per install, kept in the data folder.
export function loadToken(file) {
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  }
  const t = randomBytes(24).toString('base64url');
  writeFileSync(file, `${t}\n`, { mode: 0o600 });
  return t;
}

export function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// Short-lived six-digit codes that a phone trades for the key.
export class Pairing {
  constructor({ ttlMs = 10 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.code = null;
    this.expires = 0;
    this.misses = 0;
  }

  issue() {
    this.code = String(randomInt(0, 1e6)).padStart(6, '0');
    this.expires = Date.now() + this.ttlMs;
    this.misses = 0;
    return { code: this.code, expires: this.expires };
  }

  current() {
    return this.code && Date.now() < this.expires ? { code: this.code, expires: this.expires } : null;
  }

  // One use only; five wrong guesses burn the code.
  redeem(code) {
    if (!this.current()) return false;
    if (sameSecret(String(code ?? '').replace(/\D/g, ''), this.code)) {
      this.code = null;
      return true;
    }
    this.misses += 1;
    if (this.misses >= 5) this.code = null;
    return false;
  }
}
