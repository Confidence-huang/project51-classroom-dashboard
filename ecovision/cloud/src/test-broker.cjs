// Loopback-only TLS integration fixture. Production uses the Mosquitto config.
const tls = require('node:tls');
const { timingSafeEqual } = require('node:crypto');
function equal(a, b) { a = Buffer.from(a || ''); b = Buffer.from(b || ''); return a.length === b.length && timingSafeEqual(a, b); }
async function testBroker({ key, cert, identities, port = 0 }) {
  const mod = await import('aedes');
  const broker = mod.Aedes ? await mod.Aedes.createBroker() : mod.default();
  broker.authenticate = (client, username, password, cb) => {
    const identity = identities[username];
    if (!identity || !equal(password, identity.password)) return cb(null, false);
    client.ecoIdentity = identity; cb(null, true);
  };
  function permitted(client, topic, write) {
    if (!client) return false;
    const i = client.ecoIdentity;
    const m = /^ecovision\/([^/]+)\/(telemetry|ack|status|cmd)$/.exec(topic);
    return !!(m && i?.devices.includes(m[1]) && (i.role === 'cloud' ? (write ? m[2] === 'cmd' : m[2] !== 'cmd') : (write ? m[2] !== 'cmd' : m[2] === 'cmd')));
  }
  broker.authorizePublish = (client, packet, cb) => {
    // EC200U's serial notification omits retain; reject retained commands at the broker.
    const retainedCommand = packet.retain && packet.topic.endsWith('/cmd');
    cb(!retainedCommand && permitted(client, packet.topic, true) ? null : Error('ACL_DENIED'));
  };
  broker.authorizeSubscribe = (client, sub, cb) => cb(null, permitted(client, sub.topic, false) ? sub : null);
  const server = tls.createServer({ key, cert, minVersion: 'TLSv1.2' }, broker.handle);
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port, close: () => new Promise(resolve => { server.close(() => broker.close(resolve)); for (const socket of sockets) socket.destroy(); }) };
}
module.exports = { testBroker };
