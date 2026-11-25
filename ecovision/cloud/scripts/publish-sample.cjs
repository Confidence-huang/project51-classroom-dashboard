// Publishes one explicitly simulated sample through a configured TLS broker.
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { connectAsync } = require('mqtt');
const { validate } = require('../src/core.cjs');
const fixture = require('../../contracts/examples/telemetry_normal.json');
const policy = require('../../contracts/policy.json');

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw Error('Usage: node scripts/publish-sample.cjs <private-sample-config.json>');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.simulated !== true || !config.url?.startsWith('mqtts://') || !config.username || !config.password) {
    throw Error('TLS credentials and simulated:true are required');
  }
  const boot = randomBytes(8).toString('hex');
  const raw = JSON.stringify({ ...fixture, device_id: config.device_id, boot_id: boot, seq: 0,
    uptime_ms: 0, ts: Math.floor(Date.now()/1000), time_valid: true });
  validate('telemetry', raw);
  const client = await connectAsync(config.url, { username: config.username, password: config.password,
    ca: fs.readFileSync(config.ca), rejectUnauthorized: true, protocolVersion: 4, clean: policy.mqtt.clean_session,
    keepalive: policy.mqtt.keepalive_s, reconnectPeriod: 0, connectTimeout: 10000 });
  const { suffix, qos, retain } = policy.mqtt.topics.telemetry;
  const topic = `ecovision/${config.device_id}/${suffix}`;
  const expiry = setTimeout(() => client.end(true), 10000);
  try {
    await client.publishAsync(topic, raw, { qos, retain });
    if (!client.connected) throw Error('MQTT disconnected during publish');
    console.log(`SIMULATED ${topic} · MQTT acknowledged. Verify server logs and dashboard separately.`);
  } finally {
    clearTimeout(expiry);
    await client.endAsync(true);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
