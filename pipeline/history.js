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

const url = process.env.MQTT_URL
const topic = process.env.MQTT_TOPIC || 'classroom/room01/telemetry'
if (!url) throw new Error('需要 MQTT_URL')
if (!url.startsWith('mqtts://') && process.env.ALLOW_PLAINTEXT_TEST !== '1') throw new Error('正式连接必须使用 mqtts://')

const here = fileURLToPath(new URL('.', import.meta.url))
const site = resolve(here, '../docs')
const file = process.env.HISTORY_DB || join(here, 'telemetry.sqlite')
const historyPort = Number(process.env.HISTORY_PORT || 8899) // 避开本机 8733–8832 的 Windows 保留端口段。
mkdirSync(resolve(file, '..'), { recursive: true })
const db = new DatabaseSync(file)
db.exec(`CREATE TABLE IF NOT EXISTS telemetry (
  device_id TEXT NOT NULL, seq INTEGER NOT NULL, room_id TEXT NOT NULL,
  captured_at TEXT NOT NULL, received_at TEXT NOT NULL, simulated INTEGER NOT NULL,
  people_count INTEGER NOT NULL, temperature_c REAL NOT NULL,
  humidity_pct REAL NOT NULL, light_lux REAL NOT NULL,
  PRIMARY KEY(device_id, seq)
)`)
const save = db.prepare(`INSERT OR IGNORE INTO telemetry VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const recent = db.prepare(`SELECT * FROM telemetry ORDER BY received_at DESC, seq DESC LIMIT ?`)
const client = mqtt.connect(url, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASSWORD,
  clientId: `p51_history_${crypto.randomUUID().slice(0, 8)}`,
  protocolVersion: 4, clean: true, connectTimeout: 10000, reconnectPeriod: 3000,
})
let connected = false

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
      data.temperature_c, data.humidity_pct, data.light_lux)
    console.log(result.changes ? 'STORED' : 'DUPLICATE', JSON.stringify({ seq: data.seq, device_id: data.device_id }))
  } catch (error) { console.error('INVALID_MESSAGE', error.message) }
})

// --- 本地网站同源读取历史；路径固定，避免任意读文件 ---
createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path === '/api/telemetry') {
    const rows = recent.all(20).map(row => ({ ...row, simulated: Boolean(row.simulated) }))
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ broker_connected: connected, topic, latest: rows[0] || null, history: rows }))
    return
  }
  const prefix = '/project51-classroom-dashboard/'
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
}).listen(historyPort, '127.0.0.1', () => console.log(`SITE_READY http://127.0.0.1:${historyPort}/`))
