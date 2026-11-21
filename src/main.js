/*
智慧教室消息入口：用户提交连接信息后订阅 EMQX，再把收到的测试消息或遥测快照显示在页面。
只有 type=telemetry 的消息才写测量值；type=link_test 只证明消息到达。
调用方式：由 index.html 加载，页面上点击“连接并接收数据”。
*/
import mqtt from 'mqtt'              // 浏览器经 WSS 使用 MQTT，不依赖电脑串口。
import './style.css'                 // 看板在电脑和手机上共用同一套布局。

// --- 页面数据 ---
const elements = Object.fromEntries( // 所有可变区域集中列出，便于队友找显示位置。
  ['broker-pill','connection-detail','data-pill','last-updated','people-count','temperature-c','humidity-pct','light-lux','light-unit','people-source','temperature-source','humidity-source','light-source','link-summary','link-note','link-updated','flow-broker','flow-browser','receipt-label','message-list','message-count','latest-message','latest-message-time','history-list','history-count','history-status','open-agent-drawer','close-agent-drawer','anda-drawer-backdrop','anda-agent-drawer','agent-entry-pill','agent-entry-model-tag','anda-chat-view','anda-config-view','open-agent-config','back-to-chat','close-config-drawer','anda-topbar-model','anda-welcome-screen','anda-messages-list','anda-agent-form','anda-agent-input','anda-agent-submit','anda-platform-name','anda-platform-desc','anda-cfg-base-url','anda-cfg-key','anda-cfg-model','anda-toggle-key','anda-test-btn','anda-enter-chat-btn','anda-test-status','settings-dialog','connection-form','broker-host','broker-user','broker-password','telemetry-topic','history-api-url','form-message','settings-button','disconnect-button','close-settings']
    .map(id => [id, document.getElementById(id)])
)

const linkTopic = 'classroom/demo/ec200u/link_test'  // 已经由 EC200U 和在线调试页实测的主题。
const ecsSite = import.meta.env.MODE === 'ecs'       // ECS 构建使用同源历史 API；Pages 构建优先使用只读 HTTPS API。
function resolvePublicApiUrl() {
  const query = new URLSearchParams(location.search).get('api')?.trim()
  // GitHub Pages 的标准构建直接读取公开 API，避免换电脑构建时丢失网页数据源。
  const pagesApiUrl = location.hostname === 'confidence-huang.github.io'
    ? 'https://api.careerpathdesk.com'
    : ''
  const raw = query || (import.meta.env.VITE_PUBLIC_API_URL || pagesApiUrl).trim()
  if (!raw) return ''
  const normalized = raw.replace(/\/$/, '')
  if (normalized.startsWith('https://')) return normalized
  if (location.hostname === '127.0.0.1' && normalized.startsWith('http://127.0.0.1')) return normalized
  return ''
}
const publicApiUrl = ecsSite ? '' : resolvePublicApiUrl()
const publicApiMode = !ecsSite && Boolean(publicApiUrl)
const readings = {                            // 约定草案；队长确认数据字段后只改这里。
  people_count: 'people-count',                // K230 识别出的当前人数。
  temperature_c: 'temperature-c',              // 温度，单位摄氏度。
  humidity_pct: 'humidity-pct',                // 相对湿度，单位百分比。
  light_lux: 'light-lux',                      // 环境照度，单位 lx。
}
const state = { client: null, telemetryTopic: '', lastTelemetry: 0, simulated: false, historyAPI: '', historyConnected: false, messages: 0, agentEnabled: false, agentBusy: false, agentModel: '' } // 仅在当前页面内存中保留连接和显示状态。

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
  const live = (state.client?.connected || state.historyConnected) && age < 30_000
  const label = !state.lastTelemetry ? '等待数据' : state.simulated ? live ? '模拟数据（非实测）' : '模拟数据已过期' : live ? '实时数据' : '数据已过期'
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
  elements['latest-message'].textContent = label          // 页面上方同步提示，避免只在底部日志里出现。
  elements['latest-message-time'].textContent = `本机接收 ${time.textContent}`
}

// --- 仅按已约定格式显示真实遥测 ---
function showTelemetry(data, receivedAt = new Date().toISOString()) {
  for (const [field, id] of Object.entries(readings)) {      // 每条遥测是完整快照，缺字段显示为“—”。
    const value = data[field]
    elements[id].textContent = typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
  }
  const rawLight = Number.isInteger(data.light_raw_u16) && data.light_lux == null
  if (rawLight) elements['light-lux'].textContent = String(data.light_raw_u16)
  elements['light-unit'].textContent = rawLight ? 'ADC' : 'lx'
  state.lastTelemetry = Date.parse(data.captured_at || receivedAt) // 保留消息重放不能伪装成刚采到的新数据。
  state.simulated = data.simulated === true       // 看板显式区分模拟和真实采样。
  const simulatedSource = data.source === 'stm32_micropython_sim' ? '板端模拟 · 非传感器实测' : '电脑生成 · 非实物采集'
  elements['people-source'].textContent = state.simulated ? simulatedSource : data.people_count == null ? 'K230 尚未接入' : '来自 K230，经 STM32 上报'
  elements['temperature-source'].textContent = state.simulated ? simulatedSource : '板载 AHT20 实测'
  elements['humidity-source'].textContent = state.simulated ? simulatedSource : '板载 AHT20 实测'
  elements['light-source'].textContent = state.simulated ? simulatedSource : rawLight ? '板载光敏电阻 · 未标定 lx' : '环境传感器'
  elements['last-updated'].textContent = `${state.simulated ? '模拟 · ' : ''}接收 ${new Date(receivedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
  showFreshness()
}

// --- 从历史服务读取已入库快照并显示最近五条 ---
async function refreshHistory() {
  if (!state.historyAPI) return
  try {
    const response = await fetch(`${state.historyAPI}/api/telemetry`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    state.historyConnected = data.broker_connected
    const apiDriven = ecsSite || (publicApiMode && !state.client)
    if (apiDriven) {
      const okLabel = ecsSite ? '接收服务已连接' : '免密已连接'
      const okDetail = ecsSite
        ? 'ECS 正在订阅设备主题，等待新的上报。'
        : '只读历史 API 正在订阅 EMQX 设备主题，页面每 5 秒自动刷新。'
      const warnDetail = ecsSite
        ? 'ECS 历史服务仍可读，正在等待 MQTT 重连。'
        : '只读历史 API 仍可读，正在等待 EMQX 重连。'
      showConnection(data.broker_connected ? okLabel : '接收服务断开',
        data.broker_connected ? okDetail : warnDetail,
        data.broker_connected ? 'live' : 'warn')
    }
    elements['history-count'].textContent = `${data.history.length} 条`
    elements['history-status'].textContent = `订阅主题：${data.topic} · ${data.broker_connected ? '云端已连接' : '云端暂时断开'}`
    elements['history-list'].replaceChildren()
    for (const row of data.history.slice(0, 5)) {
      const item = document.createElement('li')
      const time = document.createElement('time')
      time.textContent = `${row.simulated ? '模拟 · ' : ''}#${row.seq} · ${new Date(row.received_at).toLocaleString('zh-CN')}`
      const people = row.people_count == null ? '人数待接入' : `${row.people_count} 人`
      const light = row.light_lux == null ? `${row.light_raw_u16} ADC` : `${row.light_lux} lx`
      item.append(time, `${people} · ${row.temperature_c} °C · ${row.humidity_pct}% · ${light}`)
      elements['history-list'].append(item)     // textContent 路径，不执行云端载荷中的 HTML。
    }
    if (data.latest && Date.parse(data.latest.captured_at) > state.lastTelemetry) showTelemetry(data.latest, data.latest.received_at)
    if (apiDriven && data.latest) {
      elements['latest-message'].textContent = `${data.latest.simulated ? '模拟样本' : '设备遥测'} #${data.latest.seq}`
      elements['latest-message-time'].textContent = `云端入库 ${new Date(data.latest.received_at).toLocaleString('zh-CN')}`
      if (!data.latest.simulated) {
        elements['link-summary'].textContent = ecsSite
          ? '已收到非模拟遥测，待与设备日志核对 4G 链路'
          : `已收到板端实测遥测 #${data.latest.seq} · 免密只读展示中`
        elements['link-updated'].textContent = elements['latest-message-time'].textContent
      }
    }
    showFreshness()
  } catch (error) {
    state.historyConnected = false
    if (ecsSite) showConnection('接收服务不可达', '无法读取 ECS 历史 API。', 'error')
    else if (publicApiMode && !state.client) showConnection('接收服务不可达', '无法读取只读 HTTPS 历史 API，可稍后刷新或使用手动 WSS 调试。', 'error')
    elements['history-status'].textContent = `历史服务不可达：${error.message}`
  }
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
  if (topic === linkTopic && data?.type === 'manual_test') {
    showMessage(topic, 'EMQX 手动测试已收到（未经过 4G）', raw) // 手动发布只证明云端到网页。
    return
  }
  if (topic === state.telemetryTopic && data?.type === 'telemetry') {
    showTelemetry(data)                          // 只有正式遥测主题和类型同时匹配才刷新读数。
    if (data.simulated === false && data.source === 'stm32_micropython_aht20_ldr') {
      elements['link-summary'].textContent = '已收到板端实测上报 · EC200U 4G 链路已验证'
      elements['link-updated'].textContent = `本机接收 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
    }
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
  state.historyAPI = elements['history-api-url'].value.trim().replace(/\/$/, '')
  if (state.historyAPI && !state.historyAPI.startsWith('https://') && location.hostname !== '127.0.0.1') {
    elements['form-message'].textContent = '公开网站的历史 API 必须使用 HTTPS'
    return
  }
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
  refreshHistory()                               // 可选历史服务不影响 MQTT 实时订阅。
  refreshAgentStatus()
}

// --- 安大+ 平台展示与预设配置 ---
const PLATFORM_PRESETS = {
  deepseek: {
    name: 'DeepSeek 配置',
    desc: '深度求索，提供高性价比推理与代码能力',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  dashscope: {
    name: '阿里云百炼 · 通义千问配置',
    desc: '阿里云通义大模型，兼具稳定企业级能力与丰富工具调用',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  zhipu: {
    name: '智谱清言 · GLM 配置',
    desc: '国产领先通用大模型，多轮 Tool-Calling 与长文本理解',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5-air',
  },
  siliconflow: {
    name: '硅基流动 · SiliconFlow 配置',
    desc: '一站式大模型推理服务，低延迟聚合开源大模型',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
  },
  custom: {
    name: '自定义 OpenAI 兼容接口',
    desc: '支持接入任意兼容 OpenAI /chat/completions 规范的 API 节点',
    baseUrl: 'https://api.your-domain.com/v1',
    model: 'custom-model',
  },
}

// --- 安大+ 抽屉视图控制 ---
function openAgentDrawer() {
  elements['anda-agent-drawer'].hidden = false
  elements['anda-agent-drawer'].setAttribute('aria-hidden', 'false')
  switchView('chat')
}

function closeAgentDrawer() {
  elements['anda-agent-drawer'].hidden = true
  elements['anda-agent-drawer'].setAttribute('aria-hidden', 'true')
}

function switchView(viewName) {
  const isChat = viewName === 'chat'
  elements['anda-chat-view'].hidden = !isChat
  elements['anda-config-view'].hidden = isChat
  if (isChat) {
    setTimeout(() => elements['anda-agent-input']?.focus(), 50)
  }
}

// --- AI 助手状态同步 ---
function updateAgentBadge(label, kind) {
  elements['agent-entry-pill'].textContent = label
  elements['agent-entry-pill'].className = `pill pill-${kind}`
}

function setAgentFormDisabled(disabled) {
  elements['anda-agent-input'].disabled = disabled
  elements['anda-agent-submit'].disabled = disabled
  for (const card of elements['anda-welcome-screen'].querySelectorAll('button')) {
    card.disabled = disabled
  }
}

async function refreshAgentStatus() {
  if (!state.historyAPI) {
    state.agentEnabled = false
    updateAgentBadge('需历史 API', 'idle')
    elements['agent-entry-model-tag'].textContent = '待配置'
    elements['anda-topbar-model'].textContent = '需历史 API'
    setAgentFormDisabled(true)
    return
  }
  try {
    const response = await fetch(`${state.historyAPI}/api/agent/status`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    state.agentEnabled = Boolean(data.enabled)
    state.agentModel = data.model || 'deepseek-chat'
    elements['agent-entry-model-tag'].textContent = state.agentModel
    elements['anda-topbar-model'].textContent = state.agentModel
    elements['anda-cfg-model'].value = state.agentModel
    if (state.agentEnabled) {
      if (!state.agentBusy) updateAgentBadge(`就绪 · ${state.agentModel}`, 'live')
      setAgentFormDisabled(state.agentBusy)
    } else {
      updateAgentBadge('未配置模型', 'warn')
      setAgentFormDisabled(true)
    }
  } catch {
    state.agentEnabled = false
    updateAgentBadge('助手暂不可达', 'error')
    setAgentFormDisabled(true)
  }
}

// --- 对话流渲染（纯 textContent 渲染，杜绝 XSS） ---
function appendUserMessage(text) {
  elements['anda-welcome-screen'].hidden = true
  const msgEl = document.createElement('div')
  msgEl.className = 'anda-msg anda-msg-user'
  const bubble = document.createElement('div')
  bubble.className = 'anda-msg-user-bubble'
  bubble.textContent = text
  msgEl.append(bubble)
  elements['anda-messages-list'].append(msgEl)
  scrollChatToBottom()
}

function appendAiLoading() {
  const msgEl = document.createElement('div')
  msgEl.className = 'anda-msg anda-msg-ai'
  const card = document.createElement('div')
  card.className = 'anda-msg-ai-card'
  const p = document.createElement('p')
  p.textContent = '正在通过 SQLite Tool-Calling 检索最新实测与趋势数据…'
  card.append(p)
  msgEl.append(card)
  elements['anda-messages-list'].append(msgEl)
  scrollChatToBottom()
  return {
    update(payload, isError = false) {
      card.replaceChildren()
      if (isError) {
        const errP = document.createElement('p')
        errP.textContent = payload.message || '请求失败，请稍后重试。'
        errP.style.color = '#ae4e48'
        card.append(errP)
        return
      }

      const lines = String(payload.answer || '').split(/\r?\n+/).map(s => s.trim()).filter(Boolean)
      for (const line of lines.length ? lines : ['（无内容）']) {
        const lineP = document.createElement('p')
        lineP.textContent = line
        card.append(lineP)
      }

      // 证据与时效栏
      const evidence = document.createElement('div')
      evidence.className = 'anda-evidence-box'

      // 工具
      const toolRow = document.createElement('div')
      toolRow.className = 'anda-evidence-row'
      const toolLbl = document.createElement('span')
      toolLbl.className = 'anda-evidence-label'
      toolLbl.textContent = '调用工具'
      const toolTags = document.createElement('div')
      toolTags.className = 'anda-evidence-tags'
      const tools = Array.isArray(payload.tools_used) ? payload.tools_used : []
      if (tools.length === 0) {
        const tag = document.createElement('span')
        tag.className = 'anda-tag'
        tag.textContent = '未调用工具'
        toolTags.append(tag)
      } else {
        for (const t of tools) {
          const tag = document.createElement('span')
          tag.className = 'anda-tag'
          tag.textContent = t.summary ? `${t.name} · ${t.summary}` : t.name
          toolTags.append(tag)
        }
      }
      toolRow.append(toolLbl, toolTags)
      evidence.append(toolRow)

      // 样本序号
      const seqRow = document.createElement('div')
      seqRow.className = 'anda-evidence-row'
      const seqLbl = document.createElement('span')
      seqLbl.className = 'anda-evidence-label'
      seqLbl.textContent = '引用样本'
      const seqTags = document.createElement('div')
      seqTags.className = 'anda-evidence-tags'
      const seqs = Array.isArray(payload.referenced_seqs) ? payload.referenced_seqs : []
      if (seqs.length === 0) {
        const tag = document.createElement('span')
        tag.className = 'anda-tag'
        tag.textContent = '暂无引用样本'
        seqTags.append(tag)
      } else {
        for (const s of seqs) {
          const tag = document.createElement('span')
          tag.className = 'anda-tag anda-tag-seq'
          tag.textContent = `#${s}`
          seqTags.append(tag)
        }
      }
      seqRow.append(seqLbl, seqTags)
      evidence.append(seqRow)

      // 数据边界
      const boundary = payload.data_boundary || {}
      const bText = document.createElement('div')
      bText.className = 'anda-boundary-text'
      const flags = [
        boundary.has_data === false ? '数据库暂无样本' : boundary.simulated ? '模拟数据' : '板端实测',
        boundary.stale ? '数据已过期（>30s）' : '时效正常',
        boundary.people_available ? '人数已接入' : 'K230 人数未接入',
        boundary.lux_calibrated ? '光照已标定 lx' : '光敏未标定 lx（仅 ADC 原码）',
        '只读建议无反控',
      ]
      bText.textContent = `数据边界：${flags.join(' · ')}`
      evidence.append(bText)

      // 元信息
      const meta = document.createElement('div')
      meta.className = 'anda-msg-meta'
      const seconds = ((Number(payload.latency_ms) || 0) / 1000).toFixed(1)
      meta.textContent = `${payload.model || state.agentModel} · 耗时 ${seconds}s · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
      evidence.append(meta)

      card.append(evidence)
      scrollChatToBottom()
    },
  }
}

function scrollChatToBottom() {
  const body = document.getElementById('anda-chat-body')
  if (body) {
    requestAnimationFrame(() => {
      body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' })
    })
  }
}

async function askAgentQuestion({ question = '', preset = '', label = '' }) {
  if (state.agentBusy || !state.historyAPI || !state.agentEnabled) return
  const clean = String(question || '').trim()
  if (!clean && !preset) return
  state.agentBusy = true
  setAgentFormDisabled(true)
  updateAgentBadge('分析中…', 'warn')

  const userText = label || clean
  appendUserMessage(userText)
  const pending = appendAiLoading()

  try {
    const response = await fetch(`${state.historyAPI}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(preset ? { preset } : { question: clean }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      pending.update({ message: payload.message || `请求失败（HTTP ${response.status}）` }, true)
      updateAgentBadge(response.status === 429 ? '已限流' : '调用异常', response.status === 429 ? 'warn' : 'error')
      return
    }
    pending.update(payload, false)
    updateAgentBadge(`就绪 · ${state.agentModel}`, 'live')
    if (!preset) elements['anda-agent-input'].value = ''
  } catch (error) {
    pending.update({ message: `网络异常：${error.message}` }, true)
    updateAgentBadge('网络异常', 'error')
  } finally {
    state.agentBusy = false
    setAgentFormDisabled(!state.agentEnabled)
  }
}

// --- 事件绑定 ---
elements['open-agent-drawer'].addEventListener('click', openAgentDrawer)
elements['close-agent-drawer'].addEventListener('click', closeAgentDrawer)
elements['close-config-drawer'].addEventListener('click', closeAgentDrawer)
elements['anda-drawer-backdrop'].addEventListener('click', closeAgentDrawer)
elements['open-agent-config'].addEventListener('click', () => switchView('config'))
elements['back-to-chat'].addEventListener('click', () => switchView('chat'))
elements['anda-enter-chat-btn'].addEventListener('click', () => switchView('chat'))

elements['anda-welcome-screen'].addEventListener('click', event => {
  const card = event.target.closest('button[data-preset]')
  if (!card || card.disabled) return
  askAgentQuestion({ preset: card.dataset.preset, label: card.querySelector('span')?.textContent.trim() })
})

elements['anda-agent-form'].addEventListener('submit', event => {
  event.preventDefault()
  askAgentQuestion({ question: elements['anda-agent-input'].value })
})

// 平台选择切换展示
const tabsContainer = document.querySelector('.anda-platform-tabs')
if (tabsContainer) {
  tabsContainer.addEventListener('click', event => {
    const tab = event.target.closest('button[data-platform]')
    if (!tab) return
    for (const btn of tabsContainer.querySelectorAll('button')) btn.classList.remove('active')
    tab.classList.add('active')
    const key = tab.dataset.platform
    const conf = PLATFORM_PRESETS[key] || PLATFORM_PRESETS.deepseek
    elements['anda-platform-name'].textContent = conf.name
    elements['anda-platform-desc'].textContent = conf.desc
    elements['anda-cfg-base-url'].value = conf.baseUrl
    elements['anda-cfg-model'].value = conf.model
  })
}

// 密文显隐提示
elements['anda-toggle-key'].addEventListener('click', () => {
  const input = elements['anda-cfg-key']
  input.type = input.type === 'password' ? 'text' : 'password'
})

// 测试连接按钮
elements['anda-test-btn'].addEventListener('click', async () => {
  const statusBox = elements['anda-test-status']
  statusBox.hidden = false
  statusBox.textContent = '正在测试连接到 ECS 助手状态接口…'
  const t0 = performance.now()
  try {
    const res = await fetch(`${state.historyAPI || ''}/api/agent/status`, { cache: 'no-store' })
    const ms = Math.round(performance.now() - t0)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    statusBox.textContent = `● 连接正常（往返延迟 ${ms} ms）· 当前后端模型：${data.model || '未识别'} · 限流策略：${data.rate_limit?.per_min || 6} 次/分，全站上限 ${data.rate_limit?.daily_cap || 200} 次/天。`
    statusBox.style.color = '#12674e'
  } catch (error) {
    statusBox.textContent = `× 连接失败：${error.message}`
    statusBox.style.color = '#ae4e48'
  }
})

// --- 原有连接与设置对话框事件 ---
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
if (ecsSite) {
  elements['settings-button'].hidden = true         // ECS 服务端持有 MQTT 密码，浏览器不再收集账号。
  elements['flow-broker'].textContent = '队长 ECS · 自建 MQTT'
  elements['flow-browser'].textContent = '当前网页 · 历史 API 展示'
  elements['receipt-label'].textContent = '服务器接收的最近消息'
  elements['link-summary'].textContent = '等待 EC200U 切换到队长 ECS'
  elements['link-note'].textContent = '当前仅模拟上报贯通；真机切换后再核对 LCD 与网页。'
  elements['message-list'].firstElementChild.textContent = 'ECS 接收的消息与去重结果显示在下方历史列表。'
  state.historyAPI = location.origin
  refreshHistory()
} else if (publicApiMode) {
  elements['settings-button'].textContent = '手动 WSS 调试 ↗'
  elements['flow-broker'].textContent = 'EMQX + 只读 API'
  elements['flow-browser'].textContent = '当前网页 · 免密自动刷新'
  elements['receipt-label'].textContent = '云端接收的最新消息'
  elements['link-summary'].textContent = '正在读取板端最新 4G 实测数据'
  elements['link-note'].textContent = '免密模式经只读 HTTPS API 拉取数据，网页源码不含 MQTT 密码。'
  elements['message-list'].firstElementChild.textContent = '免密只读模式：最新实测与历史由只读 API 自动刷新，无需输入密码。'
  elements['history-api-url'].value = publicApiUrl
  state.historyAPI = publicApiUrl
  showConnection('连接中', '正在读取只读 HTTPS 历史 API。', 'warn')
  refreshHistory()
} else if (location.hostname === '127.0.0.1' && location.port === '8899') {
  state.historyAPI = location.origin            // 本地服务与 ECS 转发预览都经同源地址读取历史。
  refreshHistory()
}
refreshAgentStatus()
setInterval(refreshHistory, 5_000)              // 每五秒读取已持久化的最新快照。
