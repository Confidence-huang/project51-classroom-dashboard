/*
智慧教室消息入口：用户提交连接信息后订阅 EMQX，再把收到的测试消息或遥测快照显示在页面。
只有 type=telemetry 的消息才写测量值；type=link_test 只证明消息到达。
调用方式：由 index.html 加载，页面上点击“连接并接收数据”。
*/
import mqtt from 'mqtt'              // 浏览器经 WSS 使用 MQTT，不依赖电脑串口。
import './style.css'                 // 看板在电脑和手机上共用同一套布局。

// --- 页面数据 ---
const elements = Object.fromEntries( // 所有可变区域集中列出，便于队友找显示位置。
  ['broker-pill','connection-detail','data-pill','last-updated','people-count','co2-ppm','temperature-c','humidity-pct','light-lux','link-summary','link-updated','message-list','message-count','settings-dialog','connection-form','broker-host','broker-user','broker-password','telemetry-topic','form-message','settings-button','disconnect-button','close-settings']
    .map(id => [id, document.getElementById(id)])
)

const linkTopic = 'classroom/demo/ec200u/link_test'  // 已经由 EC200U 和在线调试页实测的主题。
const readings = {                            // 约定草案；队长确认数据字段后只改这里。
  people_count: 'people-count',                // K230 识别出的当前人数。
  co2_ppm: 'co2-ppm',                          // CO₂ 浓度，单位 ppm。
  temperature_c: 'temperature-c',              // 温度，单位摄氏度。
  humidity_pct: 'humidity-pct',                // 相对湿度，单位百分比。
  light_lux: 'light-lux',                      // 环境照度，单位 lx。
}
const state = { client: null, telemetryTopic: '', lastTelemetry: 0, messages: 0 } // 仅在当前页面内存中保留连接和显示状态。

// --- 更新连接反馈 ---
function showConnection(label, detail, kind) {
  elements['broker-pill'].textContent = label       // 用户先看到云端连接是否成功。
  elements['broker-pill'].className = `pill pill-${kind}`
  elements['connection-detail'].textContent = detail
  elements['disconnect-button'].hidden = !state.client
}

// --- 更新数据新鲜度 ---
function showFreshness() {
  const age = Date.now() - state.lastTelemetry       // 以浏览器接收时间判断，不依赖设备时钟。
  const live = state.client?.connected && age < 30_000
  const label = !state.lastTelemetry ? '等待真实数据' : live ? '实时数据' : '数据已过期'
  elements['data-pill'].textContent = label
  elements['data-pill'].className = `pill pill-${live ? 'live' : state.lastTelemetry ? 'warn' : 'idle'}`
}

// --- 保留最近消息供联调核对 ---
function showMessage(topic, label, payload) {
  if (!state.messages) elements['message-list'].replaceChildren() // 第一条到达时移除空提示。
  const row = document.createElement('li')
  const time = document.createElement('time')
  const body = document.createElement('div')
  const title = document.createElement('strong')
  const preview = document.createElement('code')
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  title.textContent = label
  preview.textContent = `${topic} · ${payload.slice(0, 180)}` // textContent 防止消息内容变成网页代码。
  body.append(title, preview)
  row.append(time, body)
  elements['message-list'].prepend(row)
  if (elements['message-list'].children.length > 20) elements['message-list'].lastElementChild.remove()
  state.messages += 1
  elements['message-count'].textContent = `${state.messages} 条`
}

// --- 仅按已约定格式显示真实遥测 ---
function showTelemetry(data) {
  for (const [field, id] of Object.entries(readings)) {      // 每条遥测是完整快照，缺字段显示为“—”。
    const value = data[field]
    elements[id].textContent = typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
  }
  state.lastTelemetry = Date.now()
  elements['last-updated'].textContent = `本机接收 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
  showFreshness()
}

// --- MQTT 消息进入页面 ---
function receive(topic, bytes) {
  const raw = bytes.toString()                    // 外部数据只在这里解析一次。
  let data
  try { data = JSON.parse(raw) } catch { showMessage(topic, '无法解析的消息', raw); return }
  if (topic === linkTopic && data?.type === 'link_test') {
    elements['link-summary'].textContent = `收到 EC200U 链路测试 · 序号 ${data.seq ?? '—'}`
    elements['link-updated'].textContent = `本机接收 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
    showMessage(topic, '4G 链路测试', raw)
    return
  }
  if (topic === state.telemetryTopic && data?.type === 'telemetry') {
    showTelemetry(data)                          // 只有正式遥测主题和类型同时匹配才刷新读数。
    showMessage(topic, '教室实时数据', raw)
    return
  }
  showMessage(topic, '未约定的消息', raw)           // 联调时保留原文，避免悄悄丢掉新格式。
}

// --- 建立本次浏览器会话的订阅 ---
function openConnection(event) {
  event.preventDefault()
  state.client?.end(true)                         // 重连前关闭旧客户端，防止重复订阅。
  const host = elements['broker-host'].value.trim()
  const user = elements['broker-user'].value.trim()
  const password = elements['broker-password'].value
  state.telemetryTopic = elements['telemetry-topic'].value.trim()
  const URL = `wss://${host}:8084/mqtt`           // EMQX Serverless 浏览器加密连接端口。
  state.client = mqtt.connect(URL, {               // 密码只进入 MQTT 客户端内存，不写入文件或本地存储。
    username: user, password,
    clientId: `classroom_web_${crypto.randomUUID().slice(0, 12)}`,
    clean: true, connectTimeout: 10_000, reconnectPeriod: 3_000,
  })
  elements['broker-password'].value = ''          // 输入框立即清空，避免留在表单里。
  elements['settings-dialog'].close()
  showConnection('连接中', '正在连接 EMQX，成功后自动订阅消息。', 'warn')
  const client = state.client
  client.on('connect', () => {
    client.subscribe([...new Set([linkTopic, state.telemetryTopic])], { qos: 1 }, error => {
      if (error) { showConnection('订阅失败', error.message, 'error'); return }
      showConnection('云端已连接', '正在等待 EC200U 上报新消息。', 'live')
    })
  })
  client.on('message', receive)
  client.on('reconnect', () => showConnection('重连中', '网络中断，正在重新连接。', 'warn'))
  client.on('error', error => showConnection('连接异常', error.message, 'error'))
  client.on('close', () => { if (state.client === client) showConnection('已断开', '连接中断，等待自动重连。', 'warn') })
}

// --- 触发事件与反馈 ---
elements['connection-form'].addEventListener('submit', openConnection)
elements['settings-button'].addEventListener('click', () => elements['settings-dialog'].showModal())
elements['close-settings'].addEventListener('click', () => elements['settings-dialog'].close())
elements['disconnect-button'].addEventListener('click', () => {
  state.client?.end(true)                         // 主动断开后清除客户端和密码引用。
  state.client = null
  showConnection('未连接', '已主动断开，可重新输入连接信息。', 'idle')
  showFreshness()
})
setInterval(showFreshness, 1_000)               // 超过 30 秒无遥测时明确提示数据过期。
