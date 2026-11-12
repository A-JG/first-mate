import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTailnet, isLoopback, allowed, Pairing } from '../src/net.js';

test('only this machine and the tailnet are allowed by default', () => {
  assert.ok(isLoopback('::ffff:127.0.0.1'));
  assert.ok(isTailnet('100.101.102.103'));
  assert.ok(isTailnet('::ffff:100.64.0.1'));
  assert.ok(isTailnet('fd7a:115c:a1e0::f101:68e8'));
  assert.ok(!isTailnet('100.128.0.1'));
  assert.ok(!allowed('192.168.1.20'));
  assert.ok(allowed('192.168.1.20', 'lan'));
  assert.ok(!allowed('8.8.8.8', 'lan'));
});

test('pairing codes are single use and burn after five wrong guesses', () => {
  const p = new Pairing();
  const { code } = p.issue();
  assert.match(code, /^\d{6}$/);
  assert.ok(!p.redeem('000000') || code === '000000');
  assert.ok(p.redeem(`${code.slice(0, 3)} ${code.slice(3)}`), 'spaces are fine');
  assert.ok(!p.redeem(code), 'single use');
  const again = p.issue().code;
  for (let i = 0; i < 5; i++) p.redeem(again === '111111' ? '222222' : '111111');
  assert.ok(!p.redeem(again), 'burned');
});
