const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const RED = require('node-red');
const { Bridge } = require('./bridge.cjs');
const root = path.resolve(__dirname, '..');
function matchesSecret(received, expected) {
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

function isPublicControlEnabled(config) {
  return Boolean(config?.allow_public_control) || process.env.ECOVISION_ALLOW_PUBLIC_CONTROL === 'true';
}

function authorized(req, config) {
  const origin = config.public_origin || `http://${req.headers.host}`;
  if (req.headers.origin && req.headers.origin !== origin) return false;
  if (isPublicControlEnabled(config)) return true;
  const raw = req.headers.authorization || '';
  if (!raw.startsWith('Basic ')) return false;
  const received = Buffer.from(raw.slice(6), 'base64').toString();
  return matchesSecret(received, `${config.viewer_user}:${config.viewer_password}`);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tryServeStatic(req, res, staticDir) {
  if (!staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  const reqPath = (req.url || '/').split('?', 1)[0];
  if (reqPath.startsWith('/api/') || reqPath.startsWith('/dashboard')) return false;
  const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(staticDir);
  const filePath = path.resolve(resolvedRoot, rel);
  if (!filePath.startsWith(resolvedRoot + path.sep) && filePath !== resolvedRoot) return false;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function sendJson(res, status, body) {
  res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
  res.end(JSON.stringify(body));
}

function handleMonitor(req, res, cloud, config) {
  const path = req.url.split('?', 1)[0];
  if (!path.startsWith('/api/monitor/')) return false;
  const monitor = config.monitor;
  if (!monitor) {
    sendJson(res, 404, { error: 'NOT_FOUND' });
    return true;
  }
  if (!matchesSecret(req.headers.authorization || '', `Bearer ${monitor.token}`)) {
    sendJson(res, 401, { error: 'AUTH_REQUIRED' });
    return true;
  }
  if (path !== `/api/monitor/${monitor.device_id}/latest`) {
    sendJson(res, 404, { error: 'NOT_FOUND' });
    return true;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const device = cloud.deviceView(cloud.devices.get(monitor.device_id));
  const { can_control, ...snapshot } = device;
  sendJson(res, 200, snapshot);
  return true;
}
async function startServer(config) {
  if (!isPublicControlEnabled(config) && (!config.viewer_user || !config.viewer_password || config.viewer_password.length < 16)) {
    throw Error('VIEWER_CREDENTIALS_REQUIRED');
  }
  if (config.public_origin) {
    const url = new URL(config.public_origin);
    if (url.protocol !== 'https:' || url.origin !== config.public_origin) throw Error('INVALID_PUBLIC_ORIGIN');
  }
  if (config.monitor && (!/^[A-Za-z0-9_-]{32,128}$/.test(config.monitor.token || '') ||
      config.monitor.token === config.viewer_password || config.monitor.token === config.mqtt.password ||
      !config.mqtt.devices.includes(config.monitor.device_id))) throw Error('INVALID_MONITOR_CONFIG');
  const runtime = path.resolve(config.runtime || path.join(root, '.runtime/node-red'));
  fs.mkdirSync(runtime, { recursive:true });
  const logDir = path.join(runtime, 'events'); fs.mkdirSync(logDir, { recursive:true });
  let index = 0;
  function log(event) {
    let file = path.join(logDir, `events-${new Date().toISOString().slice(0,10)}-${index}.jsonl`);
    if (fs.existsSync(file) && fs.statSync(file).size > 10*1024*1024) { index++; file = path.join(logDir, `events-${new Date().toISOString().slice(0,10)}-${index}.jsonl`); }
    fs.appendFileSync(file, JSON.stringify(event)+'\n', { mode:0o600 });
    const files = fs.readdirSync(logDir).filter(n => /^events-.*\.jsonl$/.test(n)).sort((a,b) => fs.statSync(path.join(logDir,a)).mtimeMs - fs.statSync(path.join(logDir,b)).mtimeMs);
    for (const old of files.slice(0,-7)) fs.unlinkSync(path.join(logDir,old));
  }
  const bridge = new Bridge(config.mqtt, log);
  const staticDir = config.static_dir || process.env.ECOVISION_STATIC_DIR || '';
  const lastControlAt = new Map();
  const auth = (req,res,next) => {
    if (authorized(req,config)) return next();
    res.writeHead(401, {'WWW-Authenticate':'Basic realm="EcoVision local"', 'Cache-Control':'no-store'}); res.end('Authentication required');
  };
  const server = http.createServer((req,res) => {
    if (handleMonitor(req, res, bridge.cloud, config)) return;
    auth(req,res,async () => {
      res.setHeader('Cache-Control','no-store');
      const reqPath = (req.url || '/').split('?', 1)[0];
      if (req.method === 'GET' && reqPath === '/api/state') {
        const view = bridge.cloud.view();
        sendJson(res, 200, { ...view, public_control: isPublicControlEnabled(config) });
        return;
      }
      if (req.method === 'POST' && reqPath === '/api/control') {
        try {
          const body = await readJsonBody(req);
          if (!body || typeof body.device_id !== 'string' || !body.intent || typeof body.intent !== 'object' || Array.isArray(body.intent)) {
            sendJson(res, 400, { ok: false, error: 'INVALID_INTENT' });
            return;
          }
          const now = Date.now();
          const prevAt = lastControlAt.get(body.device_id) || 0;
          if (now - prevAt < 400) {
            sendJson(res, 429, { ok: false, error: 'TOO_FREQUENT' });
            return;
          }
          lastControlAt.set(body.device_id, now);
          const command = bridge.command(body.device_id, body.intent, body.observed);
          sendJson(res, 200, { ok: true, command });
        } catch (err) {
          const code = err?.message === 'PAYLOAD_TOO_LARGE' || err?.message === 'INVALID_JSON' ? 400 : 409;
          sendJson(res, code, { ok: false, error: err?.message || 'CONTROL_FAILED' });
        }
        return;
      }
      if (tryServeStatic(req, res, staticDir)) return;
      RED.httpNode(req,res,() => { res.statusCode=404; res.end('Not found'); });
    });
  });
  // Editor and admin API are absent; bind only loopback. Remote access requires an approved authenticated TLS proxy/tunnel.
  const flowFile = path.join(runtime,'flows.json'); fs.copyFileSync(path.join(root,'flows.json'), flowFile);
  RED.init(server, { userDir:runtime, nodesDir:path.join(root,'node_modules'), flowFile, httpAdminRoot:false, disableEditor:true, httpNodeRoot:'/', credentialSecret:require('node:crypto').randomBytes(32).toString('hex'),
    editorTheme:{projects:{enabled:false}},
    contextStorage:{ default:{module:'memory'} }, logging:{console:{level:'warn',metrics:false,audit:false}},
    functionGlobalContext:{ eco:{ view:() => bridge.cloud.view(), submit:(p) => {
      if (!p || typeof p.device_id !== 'string' || !p.intent || typeof p.intent !== 'object' || Array.isArray(p.intent)) throw Error('INVALID_INTENT');
      return bridge.command(p.device_id, p.intent, p.observed);
    } } },
    dashboard:{ middleware:auth, ioMiddleware:(socket,next) => authorized(socket.request,config) ? next() : next(Error('Authentication required')), maxHttpBufferSize:4096 }
  });
  bridge.start();
  await RED.start();
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(config.port ?? 1880,'127.0.0.1',resolve); });
  return { bridge, server, port:server.address().port, stop:async () => { await bridge.stop(); await RED.stop(); await new Promise(resolve => server.close(resolve)); } };
}
if (require.main === module) {
  const file = process.env.ECOVISION_CONFIG;
  if (!file) throw Error('Set ECOVISION_CONFIG to your private local JSON config');
  startServer(JSON.parse(fs.readFileSync(file))).then(app => {
    console.log(`EcoVision local dashboard: http://127.0.0.1:${app.port}/dashboard/devices`);
    const stop = async () => { await app.stop(); process.exit(0); };
    process.once('SIGINT',stop);
    process.once('SIGTERM',stop);
  }).catch(e => { console.error(e.message); process.exitCode=1; });
}
module.exports = { startServer, authorized };
