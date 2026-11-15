/*
电脑端 STM32 数据模拟器：每隔固定秒数发布一条完整 JSON 快照到 MQTT Broker。
示例：设置 MQTT_URL、MQTT_USER、MQTT_PASSWORD 后运行 npm run simulate。
此程序经电脑网络直连 Broker，不能作为 EC200U 或真实 STM32 发包证据。
*/
import mqtt from 'mqtt'                         // 复用看板已经锁定的 MQTT 客户端。
import { sample } from './telemetry.js'          // 与历史库共用同一数据格式。

const url = process.env.MQTT_URL                 // 正式环境用 mqtts://主机:8883。
const topic = process.env.MQTT_TOPIC || 'classroom/room01/telemetry'
const count = Number(process.env.SIM_COUNT || 3)
const period = Number(process.env.SIM_PERIOD_MS || 2000)
if (!url || !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(period) || period < 100) {
  throw new Error('需要 MQTT_URL；SIM_COUNT 必须为正整数，SIM_PERIOD_MS 至少 100')
}
if (!url.startsWith('mqtts://') && process.env.ALLOW_PLAINTEXT_TEST !== '1') {
  throw new Error('正式连接必须使用 mqtts://；公开测试 Broker 才设置 ALLOW_PLAINTEXT_TEST=1')
}

// --- 建立一次连接并等待 Broker ACK ---
const client = mqtt.connect(url, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASSWORD,
  clientId: `p51_sim_${crypto.randomUUID().slice(0, 8)}`,
  protocolVersion: 4,                 // MQTT 3.1.1，便于 EC200U 使用同版协议。
  connectTimeout: 10000,
  reconnectPeriod: 0,                 // 模拟器失败时立即退出，不默默重试掩盖结果。
})
await new Promise((resolve, reject) => {
  client.once('connect', resolve)
  client.once('error', reject)
})
console.log('MQTT_CONNECTED', topic)
const runID = crypto.randomUUID().slice(0, 8) // 此次演示的唯一身份，避免第二次运行的 seq 从 1 开始时撞库。

// --- 发布并等待 QoS 1 确认，retain 让云端保存最新一条 ---
for (let seq = 1; seq <= count; seq++) {
  const data = sample(seq, runID)
  await new Promise((resolve, reject) => client.publish(topic, JSON.stringify(data), { qos: 1, retain: true }, error => error ? reject(error) : resolve()))
  console.log('PUBLISH_ACK', JSON.stringify({ topic, seq, simulated: true }))
  if (seq < count) await new Promise(resolve => setTimeout(resolve, period))
}
await new Promise(resolve => client.end(false, resolve))
