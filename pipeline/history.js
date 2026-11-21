/*
历史接收服务：订阅云端遥测主题，把每条有效快照写入 SQLite，并向网站提供只读 API。
示例：设置 MQTT_URL、MQTT_USER、MQTT_PASSWORD 后运行 npm run history。
默认只监听本机 127.0.0.1:8899；公开部署须另配 HTTPS、访问控制和数据库备份。
*/
import mqtt from 'mqtt'                              // 云端 MQTT 3.1.1 订阅。
import { DatabaseSync } from 'node:sqlite'           // Node 26 自带的 SQLite。
import { createServer } from 'node:http'             // 同源提供历史 API 和本地看板。
import { readFileSync, mkdirSync } from 'node:fs'     // 读取已经构建的静态网页。
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { read } from './telemetry.js'                 // 云端消息只在入口解析一次。
import { corsHeaders, parseAllowedOrigins } from './http-policy.js'
import { createAgentHandler, handleAgentRoute } from './agent.js'

const url = process.env.MQTT_URL
const topic = process.env.MQTT_TOPIC || 'classroom/room01/telemetry'
if (!url) throw new Error('需要 MQTT_URL')
// ECS 内的历史服务只经回环地址访问本机 Broker；跨主机连接仍必须使用 TLS。
const localBroker = url === 'mqtt://127.0.0.1:1883'
if (!url.startsWith('mqtts://') && !localBroker && process.env.ALLOW_PLAINTEXT_TEST !== '1') {
  throw new Error('正式连接必须使用 mqtts://，本机 Broker 只允许 mqtt://127.0.0.1:1883')
}

const here = fileURLToPath(new URL('.', import.meta.url))
const site = resolve(here, '../docs')
const file = process.env.HISTORY_DB || join(here, 'telemetry.sqlite')
const historyPort = Number(process.env.HISTORY_PORT || 8899) // 避开本机 8733–8832 的 Windows 保留端口段。
const allowedOrigins = parseAllowedOrigins(process.env.CORS_ALLOW_ORIGIN)
const apiOnly = process.env.HISTORY_API_ONLY === '1'
mkdirSync(resolve(file, '..'), { recursive: true })
const db = new DatabaseSync(file)
db.exec(`CREATE TABLE IF NOT EXISTS telemetry_v2 (
  device_id TEXT NOT NULL, seq INTEGER NOT NULL, room_id TEXT NOT NULL,
  captured_at TEXT NOT NULL, received_at TEXT NOT NULL, simulated INTEGER NOT NULL,
  people_count INTEGER, temperature_c REAL NOT NULL,
  humidity_pct REAL NOT NULL, light_lux REAL, light_raw_u16 INTEGER,
  PRIMARY KEY(device_id, seq)
)`)
// 旧表限制人数和 lx 必填；新表允许尚未接入 K230 与未标定的光敏原码。
// 复制旧数据但保留原表，已有本机历史不会被迁移操作删除。
const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry'").get()
if (legacy) db.exec(`INSERT OR IGNORE INTO telemetry_v2
  SELECT device_id, seq, room_id, captured_at, received_at, simulated,
    people_count, temperature_c, humidity_pct, light_lux, NULL FROM telemetry`)
const save = db.prepare(`INSERT OR IGNORE INTO telemetry_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const recent = db.prepare(`SELECT * FROM telemetry_v2 ORDER BY received_at DESC, seq DESC LIMIT ?`)
const client = mqtt.connect(url, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASSWORD,
  clientId: `p51_history_${crypto.randomUUID().slice(0, 8)}`,
  protocolVersion: 4, clean: true, connectTimeout: 10000, reconnectPeriod: 3000,
})
let connected = false
const agent = createAgentHandler({ db, getBrokerState: () => ({ connected, topic }) })

// --- Broker 连接及订阅反馈 ---
client.on('connect', () => client.subscribe(topic, { qos: 1 }, error => {
  if (error) { console.error('SUBSCRIBE_FAILED', error.message); return }
  connected = true
  console.log('SUBSCRIBED', topic)
}))
client.on('close', () => { connected = false })
client.on('error', error => console.error('MQTT_ERROR', error.message))

// --- 收到完整快照后去重落库，保留原设备时间与云端接收时间 ---
client.on('message', (receivedTopic, bytes) => {
  if (receivedTopic !== topic) return
  try {
    const data = read(bytes)
    const result = save.run(data.device_id, data.seq, data.room_id, data.captured_at,
      new Date().toISOString(), Number(data.simulated), data.people_count,
      data.temperature_c, data.humidity_pct, data.light_lux, data.light_raw_u16 ?? null)
    console.log(result.changes ? 'STORED' : 'DUPLICATE', JSON.stringify({ seq: data.seq, device_id: data.device_id }))
  } catch (error) { console.error('INVALID_MESSAGE', error.message) }
})

// --- 本地网站同源读取历史；路径固定，避免任意读文件 ---
createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path === '/api/telemetry') {
      const cors = corsHeaders(request.headers.origin, allowedOrigins)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, cors)
        response.end()
        return
      }
      if (request.method !== 'GET') {
        response.writeHead(405, { ...cors, Allow: 'GET, OPTIONS' })
        response.end('Method not allowed')
        return
      }
      const rows = recent.all(20).map(row => ({ ...row, simulated: Boolean(row.simulated) }))
      response.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ broker_connected: connected, topic, latest: rows[0] || null, history: rows }))
      return
    }
    if (await handleAgentRoute(request, response, { path, agent, allowedOrigins })) return
    if (apiOnly) {
      response.writeHead(404)
      response.end('Not found')
      return
    }
    const prefix = '/smart-classroom-web/'
    const relative = path === '/' ? 'index.html' : path.startsWith(prefix) ? path.slice(prefix.length) || 'index.html' : null
    const target = relative && resolve(site, relative)
    if (!target || (target !== site && !target.startsWith(site + sep))) {
      response.writeHead(404); response.end('Not found'); return
    }
    try {
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
      response.writeHead(200, { 'Content-Type': (types[extname(target)] || 'application/octet-stream') + '; charset=utf-8' })
      response.end(readFileSync(target))
    } catch { response.writeHead(404); response.end('Not found') }
  } catch (error) {
    console.error('HTTP_HANDLER_ERROR', error.message)
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'INTERNAL_ERROR', message: '服务内部异常' }))
    }
  }
}).listen(historyPort, '127.0.0.1', () => console.log(`SITE_READY http://127.0.0.1:${historyPort}/`))
