const mqtt = require('mqtt');
const fs = require('node:fs');
const { Cloud } = require('./core.cjs');
class Bridge {
  constructor(config, log = () => {}) {
    if (!config.url?.startsWith('mqtts://')) throw Error('TLS_REQUIRED');
    this.config = config; this.log = log; this.stopped = false; this.attempt = 0;
    this.cloud = new Cloud({ devices: config.devices, simulated: config.simulated || [], log });
  }
  start() {
    const c = this.config;
    const client = mqtt.connect(c.url, { protocolVersion: 4, clean: true, keepalive: 30, reconnectPeriod: 0, connectTimeout: 10000,
      username: c.username, password: c.password, ca: fs.readFileSync(c.ca), rejectUnauthorized: true, queueQoSZero: false,
      clientId: `eco-cloud-${require('node:crypto').randomUUID()}` });
    this.client = client;
    client.on('connect', () => {
      client.subscribe(c.devices.flatMap(id => ['telemetry', 'ack', 'status'].map(k => `ecovision/${id}/${k}`)), { qos: 1 }, (err, granted) => {
        if (err || granted.some(g => g.qos === 128)) { this.cloud.event('subscription_error', {}); client.end(true); return; }
        this.attempt = 0; this.cloud.setConnected(true);
      });
    });
    client.on('message', (topic, payload, packet) => this.cloud.ingest(topic, payload, packet.retain));
    client.on('error', err => this.cloud.event('mqtt_error', { reason: err.code || 'CONNECTION_ERROR' }));
    client.once('close', () => {
      this.cloud.setConnected(false);
      // Dispose the old outgoing store. Never replay old commands after reconnect.
      client.end(true);
      if (!this.stopped) {
        const base = [2000, 5000, 10000, 30000, 60000][Math.min(this.attempt++, 4)];
        this.timer = setTimeout(() => this.start(), base * (1 + Math.random() * 0.2));
      }
    });
    return this;
  }
  command(id, intent) {
    if (!this.client?.connected || !this.cloud.connected) throw Error('CONTROL_DISABLED');
    const command = this.cloud.command(id, intent);
    this.client.publish(`ecovision/${id}/cmd`, JSON.stringify(command), { qos: 1, retain: false }, err => {
      if (err) this.cloud.event('publish_error', { cmd_id: command.cmd_id, result: 'UNKNOWN' });
      // PUBACK is transport delivery, never terminal APPLIED.
    });
    return command;
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); this.cloud.setConnected(false); if (this.client) await this.client.endAsync(true); }
}
module.exports = { Bridge };
