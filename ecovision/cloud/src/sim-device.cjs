// Cloud integration fixture only. No GPIO, no claim of a complete STM32 simulator.
const mqtt = require('mqtt');
const { randomBytes } = require('node:crypto');
const { validate } = require('./core.cjs');
const fixture = require('../../contracts/examples/telemetry_normal.json');
function simulator(config) {
  const started = performance.now(), boot = randomBytes(8).toString('hex');
  let seq = 0, deadline = 0;
  const cache = new Map();
  const state = { ...fixture, device_id: config.device_id, boot_id: boot, mode: 'AUTO', fan_out: 0, led_out: 0, hold_remaining_s: 0, control_epoch: 0, last_cmd_id: null };
  const status = (n, online) => JSON.stringify({ v: '1.0.0', device_id: config.device_id, boot_id: boot, seq: n, state: online ? 'online' : 'offline', ts: online ? Math.floor(Date.now()/1000) : null, reason: online ? 'connected' : 'lwt' });
  const root = `ecovision/${config.device_id}/`;
  const client = mqtt.connect(config.url, { protocolVersion: 4, clean: true, keepalive: 30, reconnectPeriod: 0, username: config.username, password: config.password,
    ca: require('node:fs').readFileSync(config.ca), rejectUnauthorized: true, will: { topic: root + 'status', payload: status(1, false), qos: 1, retain: true } });
  function report() {
    if (!client.connected) return;
    if (deadline && performance.now() >= deadline) { state.mode = 'AUTO'; deadline = 0; state.fan_out = 0; state.led_out = 0; }
    state.hold_remaining_s = deadline ? Math.max(0, Math.ceil((deadline - performance.now())/1000)) : 0;
    client.publish(root + 'telemetry', JSON.stringify({ ...state, seq: seq++ >>> 0, uptime_ms: Math.floor(performance.now()-started), ts: Math.floor(Date.now()/1000) }), { qos: 1, retain: false });
  }
  client.on('connect', () => client.subscribe(root + 'cmd', { qos: 1 }, () => { client.publish(root + 'status', status(0, true), { qos: 1, retain: true }); report(); }));
  client.on('message', (topic, raw, packet) => {
    let c; try { c = validate('command', raw); } catch { return; }
    if (topic !== root + 'cmd' || c.device_id !== config.device_id) return;
    const now = Math.floor(Date.now()/1000), uptime = Math.floor(performance.now()-started);
    const canonical = JSON.stringify(Object.keys(c).sort().map(k => [k, c[k]]));
    let reason = packet.retain ? 'RETAINED_COMMAND' : c.boot_id !== boot ? 'BOOT_MISMATCH' : null;
    const saved = cache.get(c.cmd_id);
    if (!reason && saved) {
      if (saved.canonical === canonical) { client.publish(root + 'ack', saved.raw, { qos: 1, retain: false }); return; }
      reason = 'CMD_ID_CONFLICT';
    }
    reason ||= now < c.issued_at ? 'FUTURE_COMMAND' : now >= c.issued_at+c.ttl_s ? 'EXPIRED' : c.control_epoch !== state.control_epoch ? 'EPOCH_MISMATCH' : null;
    for (const [id, item] of cache) if (now >= item.expiry) cache.delete(id);
    if (!reason && cache.size >= 32) reason = 'BUSY';
    if (!reason) {
      state.mode = c.mode; state.fan_out = c.mode === 'AUTO' ? 0 : c.fan_out; state.led_out = c.mode === 'AUTO' ? 0 : c.led_out;
      deadline = c.mode === 'AUTO' ? 0 : performance.now()+c.hold_s*1000; state.hold_remaining_s = c.hold_s; state.last_cmd_id = c.cmd_id;
    }
    const ack = { v: '1.0.0', device_id: state.device_id, boot_id: boot, cmd_id: c.cmd_id, status: reason ? 'REJECTED' : 'APPLIED', reason: reason || 'OK', received_at: now, uptime_ms: uptime,
      control_epoch: state.control_epoch, mode: state.mode, fan_out: state.fan_out, led_out: state.led_out, hold_remaining_s: state.hold_remaining_s };
    const rawAck = JSON.stringify(ack);
    if (!reason) cache.set(c.cmd_id, { raw: rawAck, canonical, expiry: c.issued_at+c.ttl_s });
    setTimeout(() => { if (client.connected) { client.publish(root + 'ack', rawAck, { qos: 1, retain: false }); report(); } }, config.ack_delay_ms ?? 800);
  });
  client.on('error', () => {});
  const timer = setInterval(report, 5000);
  return { client, close: async () => { clearInterval(timer); await client.endAsync(true); } };
}
module.exports = { simulator };
