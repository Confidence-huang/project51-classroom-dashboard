const Ajv = require('ajv/dist/2020');
const json = require('json-dup-key-validator');
const { randomUUID } = require('node:crypto');
const policy = require('../../contracts/policy.json');
const ajv = new Ajv({ strict: true });
// The schemas supply both the wire validators and the dashboard level range.
const schemas = Object.fromEntries(['telemetry', 'ack', 'status', 'command'].map(k => [k, require(`../../contracts/${k}.schema.json`)]));
const validators = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [kind, ajv.compile(schema)]));
const newer = (n, old) => old === undefined || ((n - old) >>> 0) > 0 && ((n - old) >>> 0) < 0x80000000;
function validate(kind, raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (typeof text !== 'string' || Buffer.byteLength(text) > policy.mqtt.max_payload_bytes) throw Error('PAYLOAD_SIZE');
  if (Buffer.isBuffer(raw) && !Buffer.from(text).equals(raw)) throw Error('UTF8');
  const p = json.parse(text, false);
  if (!validators[kind]?.(p)) throw Error('SCHEMA');
  if (kind === 'telemetry') {
    for (const [value, valid, age, limit] of [['count', 'vision_valid', 'vision_age_ms', 5000], ['temp_c', 'temp_valid', 'temp_age_ms', 10000], ['humidity_pct', 'humidity_valid']]) {
      if (p[valid] !== (p[value] !== null)) throw Error('VALIDITY');
      if (p[valid] && age && (p[age] === null || p[age] >= limit)) throw Error('AGE');
    }
    if (p.time_valid !== (p.ts !== null)) throw Error('TIME');
  }
  if (['telemetry', 'ack'].includes(kind) && p.mode !== 'REMOTE' && p.hold_remaining_s !== 0) throw Error('LEASE');
  if (kind === 'ack' && ((p.status === 'APPLIED') !== (p.reason === 'OK'))) throw Error('ACK_REASON');
  if (kind === 'status' && ((p.state === 'online') !== (p.reason === 'connected'))) throw Error('STATUS_REASON');
  if (kind === 'command') {
    if (p.mode === 'AUTO' ? p.fan_out !== null || p.led_out !== null || p.hold_s !== 0 : p.fan_out === null || p.led_out === null || p.hold_s < 30) throw Error('PARAMETERS');
  }
  return p;
}
class Cloud {
  constructor({ devices, simulated = [], now = () => performance.now(), utc = () => Math.floor(Date.now() / 1000), log = () => {} }) {
    if (!devices?.length || devices.some(d => !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(d))) throw Error('DEVICES');
    this.devices = new Map(devices.map(id => [id, { device_id: id, simulated: simulated.includes(id), retired: new Set(), telemetry: null, status: null, seen: null }]));
    this.now = now; this.utc = utc; this.log = log; this.commands = []; this.connected = false;
  }
  event(type, detail) { this.log({ observed_at: new Date().toISOString(), type, ...detail }); }
  setConnected(value) {
    this.connected = value;
    // A new broker connection must receive new telemetry before control resumes.
    if (!value) for (const d of this.devices.values()) d.seen = null;
    this.event('transport', { connected: value });
  }
  ingest(topic, raw, retain = false) {
    try {
      const m = /^ecovision\/([^/]+)\/(telemetry|ack|status)$/.exec(topic);
      if (!m || !this.devices.has(m[1])) throw Error('TOPIC');
      const [, id, kind] = m, p = validate(kind, raw), d = this.devices.get(id);
      if (p.device_id !== id || (retain && kind !== 'status')) throw Error('IDENTITY_OR_RETAIN');
      if (kind === 'ack') {
        const record = this.commands.find(r => r.command.cmd_id === p.cmd_id && r.command.device_id === id && r.command.boot_id === p.boot_id);
        if (!record) throw Error('UNRELATED_ACK');
        // An extended command needs confirmation of its exact fan level and lamp setting.
        const requested = record.command;
        if (p.status === 'APPLIED' && requested.fan_level !== undefined &&
            (p.mode !== requested.mode || p.fan_level !== requested.fan_level || p.led_out !== requested.led_out)) {
          throw Error('ACK_OUTPUT_MISMATCH');
        }
        const late = this.now() - record.started >= policy.mqtt.ack_timeout_s * 1000;
        record.acks.push({ observed_at: new Date().toISOString(), payload: p });
        record.acks = record.acks.slice(-32);
        if (record.state !== 'APPLIED') { record.state = p.status; record.reason = p.reason; record.late = late; }
        this.event('ack', { device_id: id, simulated: d.simulated, payload: p, late });
        return true;
      }
      if (kind === 'telemetry') {
        if (d.retired.has(p.boot_id)) throw Error('RETIRED_BOOT');
        if (d.telemetry?.boot_id !== p.boot_id) {
          if (d.telemetry) d.retired.add(d.telemetry.boot_id);
          d.status = null; d.telemetry = null;
        }
        if (!newer(p.seq, d.telemetry?.seq)) throw Error('OLD_SEQUENCE');
        d.telemetry = p; d.seen = this.now(); d.last_received_at = new Date().toISOString();
      } else {
        if (!d.telemetry || p.boot_id !== d.telemetry.boot_id) throw Error('UNCONFIRMED_BOOT');
        if (!newer(p.seq, d.status?.seq)) throw Error('OLD_SEQUENCE');
        d.status = p;
      }
      this.event(kind, { device_id: id, simulated: d.simulated, payload: p });
      return true;
    } catch (e) { this.event('dropped', { topic, reason: e.message }); return false; }
  }
  deviceView(d) {
    const age = d.seen === null ? null : Math.max(0, this.now() - d.seen);
    const stale = age === null || age >= policy.mqtt.dashboard_stale_s * 1000;
    const offline = !this.connected || d.status?.state === 'offline' || d.telemetry?.net_state !== 'ONLINE';
    return { device_id: d.device_id, simulated: d.simulated, telemetry: d.telemetry, status: d.status, last_received_at: d.last_received_at || null, age_ms: age,
      connection: stale ? 'STALE' : offline ? 'OFFLINE' : 'ONLINE',
      can_control: !stale && !offline && d.telemetry.time_valid && d.telemetry.mode !== 'LOCAL_OFF' };
  }
  command(id, intent, observed) {
    const d = this.devices.get(id);
    const view = d && this.deviceView(d);
    if (!view?.can_control) throw Error('CONTROL_DISABLED');
    const t = d.telemetry;
    // Sign only the device session the operator saw, even if telemetry has since recovered.
    if (observed?.boot_id !== t.boot_id || observed?.control_epoch !== t.control_epoch) throw Error('STALE_CONTROL_CONTEXT');
    if (Object.keys(intent).some(k => !['mode', 'fan_out', 'fan_level', 'led_out', 'hold_s'].includes(k))) throw Error('INTENT');
    if (this.commands.filter(r => r.state === 'PENDING' && this.now() - r.started < 10000).length >= 32) throw Error('BUSY');
    // A level in fresh telemetry advertises support for the optional command field.
    if (intent.fan_level !== undefined && (intent.mode !== 'REMOTE' || t.fan_level === undefined)) throw Error('FAN_LEVEL_UNAVAILABLE');
    const ttl = policy.control.ttl_default_s;
    const cloudUtc = this.utc();
    // Advance the device's trusted sample by elapsed time since receipt. Inbound latency can only make this estimate older.
    const deviceUtc = t.ts + Math.floor(view.age_ms / 1000);
    // Reject differences outside a command lifetime. Keep the receiver's future and expiry checks unchanged.
    if (Math.abs(cloudUtc - deviceUtc) >= ttl) throw Error('CLOCK_SKEW');
    const cmd = { v: policy.version, device_id: id, boot_id: t.boot_id, control_epoch: t.control_epoch, cmd_id: randomUUID(), issued_at: Math.min(cloudUtc, deviceUtc), ttl_s: ttl,
      mode: intent.mode, fan_out: intent.mode === 'AUTO' ? null : intent.fan_out, led_out: intent.mode === 'AUTO' ? null : intent.led_out, hold_s: intent.mode === 'AUTO' ? 0 : intent.hold_s ?? policy.control.hold_default_s };
    if (intent.fan_level !== undefined) cmd.fan_level = intent.fan_level;
    validate('command', JSON.stringify(cmd));
    this.commands.push({ command: cmd, started: this.now(), state: 'PENDING', late: false, acks: [] });
    // Keep active records; historical records are also durably logged.
    while (this.commands.length > 256) { const i = this.commands.findIndex(r => this.now() - r.started >= 30000); if (i < 0) break; this.commands.splice(i, 1); }
    this.event('command', { simulated: d.simulated, payload: cmd, state: 'PENDING' });
    return cmd;
  }
  view() {
    for (const r of this.commands) if (r.state === 'PENDING' && this.now() - r.started >= policy.mqtt.ack_timeout_s * 1000) {
      r.state = 'TIMEOUT'; this.event('timeout', { cmd_id: r.command.cmd_id, result: 'UNKNOWN' });
    }
    return { transport_connected: this.connected,
      hold_default_s: policy.control.hold_default_s, fan_level_max: schemas.command.properties.fan_level.maximum,
      devices: [...this.devices.values()].map(d => this.deviceView(d)), commands: this.commands.slice().reverse().map(({ started, ...r }) => ({...r, ack_remaining_ms: Math.max(0, policy.mqtt.ack_timeout_s*1000 - (this.now()-started))})) };
  }
}
module.exports = { Cloud, validate, newer };
