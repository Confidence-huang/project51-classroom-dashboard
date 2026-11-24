const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Cloud } = require('../../cloud/src/core.cjs');
const fixture = require('../../contracts/examples/telemetry_normal.json');
const applied = require('../../contracts/examples/ack_applied.json');
function setup({ clockOffset = 0 } = {}) {
  let now = 1000000;
  const events = [];
  const c = new Cloud({ devices: ['ev001'], simulated: ['ev001'], now: () => now,
    utc: () => Math.floor(now / 1000) + clockOffset, log: e => events.push(e) });
  const send = (kind, data, retain = false) => c.ingest(`ecovision/ev001/${kind}`, JSON.stringify(data), retain);
  const telemetry = { ...fixture, seq: 1, ts: 1000 };
  c.setConnected(true);
  send('telemetry', telemetry);
  return { c, events, send, telemetry, advance: ms => { now += ms; } };
}
test('cloud state implementation exists', () => assert.equal(typeof Cloud, 'function'));
test('fresh telemetry enables control; duplicate does not refresh 15s deadline', () => {
  const { c, send, telemetry, advance } = setup();
  assert.equal(c.view().devices[0].can_control, true);
  advance(14000); send('telemetry', telemetry); advance(1000);
  assert.equal(c.view().devices[0].connection, 'STALE');
  assert.throws(() => c.command('ev001', { mode: 'AUTO' }), /CONTROL_DISABLED/);
});
test('command is PENDING, bound to current session and default TTL/lease', () => {
  const { c, telemetry } = setup();
  const cmd = c.command('ev001', { mode: 'REMOTE', fan_out: 1, led_out: 0 });
  assert.equal(cmd.boot_id, telemetry.boot_id); assert.equal(cmd.control_epoch, telemetry.control_epoch);
  assert.equal(cmd.ttl_s, 15); assert.equal(cmd.hold_s, 120);
  assert.equal(c.view().commands[0].state, 'PENDING');
  assert.equal(c.view().commands[0].ack_remaining_ms, 10000);
  assert.equal(c.view().devices[0].telemetry.mode, telemetry.mode);
});
test('a fresh device clock two seconds behind the cloud does not produce a future command', () => {
  const { c, telemetry, advance } = setup({ clockOffset: 2 });
  advance(4200);
  const command = c.command('ev001', { mode: 'AUTO' });
  assert.equal(command.issued_at, telemetry.ts + 4);
  assert.equal(command.ttl_s, 15);
});
test('large clock divergence blocks sending until fresh, aligned telemetry arrives', () => {
  const { c, send, telemetry } = setup({ clockOffset: 60 });
  assert.throws(() => c.command('ev001', { mode: 'AUTO' }), /CLOCK_SKEW/);
  assert.equal(c.view().commands.length, 0);
  send('telemetry', { ...telemetry, seq: 2, ts: telemetry.ts + 60 });
  assert.equal(c.command('ev001', { mode: 'AUTO' }).issued_at, telemetry.ts + 60);
});
test('ACK confirms history only; wrong boot/unrelated ID cannot confirm', () => {
  const { c, send, telemetry } = setup();
  const cmd = c.command('ev001', { mode: 'REMOTE', fan_out: 1, led_out: 1 });
  const ack = { ...applied, cmd_id: cmd.cmd_id, boot_id: telemetry.boot_id };
  send('ack', { ...ack, boot_id: 'ffffffff' });
  assert.equal(c.view().commands[0].state, 'PENDING');
  send('ack', ack);
  assert.equal(c.view().commands[0].state, 'APPLIED');
  assert.deepEqual(c.view().devices[0].telemetry, telemetry);
});
test('10 seconds without ACK means unknown; late ACK updates history', () => {
  const { c, send, advance } = setup();
  const cmd = c.command('ev001', { mode: 'AUTO' }); advance(10000);
  assert.equal(c.view().commands[0].state, 'TIMEOUT');
  send('ack', { ...applied, cmd_id: cmd.cmd_id, mode: 'AUTO', hold_remaining_s: 0 });
  assert.equal(c.view().commands[0].state, 'APPLIED');
  assert.equal(c.view().commands[0].late, true);
});
test('reject unknown keys, duplicate JSON keys, oversized, retained telemetry and semantic invalidity', () => {
  const { c, send, telemetry } = setup();
  assert.equal(send('telemetry', { ...telemetry, seq: 2, extra: 1 }), false);
  assert.equal(c.ingest('ecovision/ev001/telemetry', JSON.stringify(telemetry).replace('"seq":1', '"seq":1,"seq":2')), false);
  assert.equal(c.ingest('ecovision/ev001/telemetry', ' '.repeat(2049)), false);
  assert.equal(send('telemetry', { ...telemetry, seq: 2 }, true), false);
  assert.equal(send('telemetry', { ...telemetry, seq: 2, count: null, vision_valid: true }), false);
  assert.equal(send('telemetry', { ...telemetry, seq: 2, time_valid: false }), false);
});
test('modulo sequence wraps, old boot telemetry/status cannot roll back current state', () => {
  const { c, send, telemetry } = setup();
  const next = { ...telemetry, boot_id: 'abcdef12', seq: 4294967295 };
  assert.equal(send('telemetry', next), true);
  assert.equal(send('telemetry', { ...next, seq: 0 }), true);
  assert.equal(send('telemetry', { ...next, seq: 4294967294 }), false);
  assert.equal(send('telemetry', { ...telemetry, seq: 2 }), false);
  assert.equal(send('status', { v: '1.0.0', device_id: 'ev001', boot_id: telemetry.boot_id, seq: 9, state: 'offline', reason: 'lwt', ts: null }, true), false);
  assert.equal(c.view().devices[0].connection, 'ONLINE');
});
test('status sequence protects reconnect and offline disables control', () => {
  const { c, send, telemetry } = setup();
  const s = { v: '1.0.0', device_id: 'ev001', boot_id: telemetry.boot_id, seq: 3, state: 'online', reason: 'connected', ts: null };
  send('status', s, true); send('status', { ...s, seq: 2, state: 'offline', reason: 'lwt' }, true);
  assert.equal(c.view().devices[0].can_control, true);
  send('status', { ...s, seq: 4, state: 'offline', reason: 'lwt' }, true);
  assert.equal(c.view().devices[0].can_control, false);
});
test('LOCAL_OFF, untrusted time, transport loss and non-ONLINE snapshots disable control', () => {
  for (const patch of [{ mode: 'LOCAL_OFF', hold_remaining_s: 0 }, { ts: null, time_valid: false }, { net_state: 'OFFLINE', faults: ['NET_OFFLINE'] }]) {
    const { c, send, telemetry } = setup(); send('telemetry', { ...telemetry, ...patch, seq: 2 });
    assert.equal(c.view().devices[0].can_control, false);
  }
  const { c } = setup(); c.setConnected(false); assert.equal(c.view().devices[0].can_control, false);
});
test('rejections are recorded on every delivery and cannot erase a successful ACK', () => {
  const { c, send } = setup(); const cmd = c.command('ev001', { mode: 'AUTO' });
  const a = { ...applied, cmd_id: cmd.cmd_id, mode: 'AUTO', hold_remaining_s: 0 };
  send('ack', { ...a, status: 'REJECTED', reason: 'BUSY' }); send('ack', { ...a, status: 'REJECTED', reason: 'BUSY' });
  assert.equal(c.view().commands[0].acks.length, 2);
  send('ack', a); send('ack', { ...a, status: 'REJECTED', reason: 'EXPIRED' });
  assert.equal(c.view().commands[0].state, 'APPLIED');
});
