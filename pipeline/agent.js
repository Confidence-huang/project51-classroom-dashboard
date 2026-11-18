/*
智慧教室网页 LLM Agent 模块（零第三方 SDK 依赖，复用 Node 26 原生 fetch 与 node:sqlite）。
支持 DeepSeek / 阿里云百炼通义千问 / 智谱 GLM / 硅基流动 / 任意 OpenAI 兼容 /chat/completions 接口。
通过只读 SQLite Tool-Calling 查询真实遥测与统计趋势，并强制防编造边界与三层防刷限流。
*/
import { corsHeaders, isOriginAllowed } from './http-policy.js'

const MAX_BODY_BYTES = 4096
const MAX_QUESTION_CHARS = 300
const MAX_TOOL_ROUNDS = 3
const STALE_THRESHOLD_SECONDS = 30

export const AGENT_PRESETS = Object.freeze({
  diagnose: {
    id: 'diagnose',
    label: '当前教室体检',
    question: '请检查教室最新一条实测数据与设备状态，评估当前温湿度舒适度，并明确说明尚未接入或未标定的传感器项。',
  },
  trend: {
    id: 'trend',
    label: '近 1 小时趋势',
    question: '请统计近 60 分钟的板端实测数据，概括温度、相对湿度和光敏 ADC 原码的波动范围与变化趋势，并引用具体样本序号。',
  },
  energy: {
    id: 'energy',
    label: '节能建议（只读）',
    question: '请结合最新实测温湿度与近 60 分钟趋势，给出教室通风或空调运行建议；若人数未接入或光照未标定，请明示限制并说明仅为只读建议。',
  },
  health: {
    id: 'health',
    label: '链路与传感器自检',
    question: '请检查 4G/MQTT 上报频率、最新样本新鲜度、有无断档，并列出当前已实测接入与尚未接入的硬件清单。',
  },
})

const SYSTEM_PROMPT = [
  '你是「移远杯 · 智慧教室」系统的 AI 教室助手，面向比赛评委、老师和学生解答教室环境监测与运行状态问题。',
  '你必须严格遵守以下事实纪律，违者视为严重错误：',
  '1. 回答任何当前状态、趋势、链路或建议问题前，必须先调用本地 SQLite 只读工具取数，严禁凭空猜测或复用记忆中的旧值。',
  '2. 严禁编造未接入数据：若工具返回 people_count 为 null，绝对禁止估算或杜撰人数，必须明确写“K230 人数尚未接入”。',
  '3. 严禁编造照度换算：若 light_lux 为 null 且仅有 light_raw_u16，绝对禁止把 ADC 原码换算成 lx，只能说明 ADC 原码数值及相对变化趋势，并注明“光敏电阻尚未标定 lx”。',
  '4. 严格区分真实与模拟数据：若数据为 simulated=true，必须显式注明为模拟数据，不得冒充板端实测；若样本距今超过 30 秒（stale=true），必须提醒“数据已过期”。',
  '5. 若用户询问空调/灯光控制或节能策略，只能给出只读决策建议，并明确说明当前系统尚未接入空调/继电器反控执行器。',
  '6. 回答保持简洁、条理清晰（中文，控制在 250 字以内为宜），关键数值尽量附带引用样本序号（如 #848323113）和采样/入库时间。',
].join('\n')

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_latest_telemetry',
      description: '读取 SQLite 数据库中最新一条遥测快照、MQTT 连接状态、数据时效（是否超过30秒过期）及最新实测样本。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_samples',
      description: '读取最近若干条遥测样本明细（包含序号 seq、时间、温度、湿度、光敏 ADC/lx、人数与模拟标记），默认仅查真实板端数据。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 15，最多 50' },
          include_simulated: { type: 'boolean', description: '是否包含模拟数据，默认 false（仅查真实板端实测）' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_telemetry_stats',
      description: '由服务端直接计算指定时间窗口内遥测数据的准确统计量（条数、首尾序号、温湿度及光敏 ADC 的最小/最大/均值/首尾变化）。',
      parameters: {
        type: 'object',
        properties: {
          window_minutes: { type: 'integer', minimum: 5, maximum: 1440, description: '统计时间窗口（分钟），默认 60' },
          include_simulated: { type: 'boolean', description: '是否包含模拟数据，默认 false' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_device_health',
      description: '检查设备 4G/MQTT 上报平均间隔、最大断档、数据是否过期，以及当前硬件传感器的接入与未接入清单。',
      parameters: {
        type: 'object',
        properties: {
          sample_limit: { type: 'integer', minimum: 2, maximum: 50, description: '用于计算上报间隔的最近样本数，默认 20' },
        },
        additionalProperties: false,
      },
    },
  },
]

function clampInt(raw, fallback, min, max) {
  const value = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function round2(num) {
  return Math.round(num * 100) / 100
}

function isValidBaseUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) return true
    return false
  } catch {
    return false
  }
}

export function readAgentConfig(env = process.env) {
  const provider = String(env.LLM_PROVIDER || 'deepseek').trim() || 'deepseek'
  const baseUrl = String(env.LLM_BASE_URL || 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '')
  const model = String(env.LLM_MODEL || 'deepseek-chat').trim()
  const apiKey = String(env.LLM_API_KEY || '').trim()
  const validUrl = isValidBaseUrl(baseUrl)
  return {
    provider,
    baseUrl,
    model,
    apiKey,
    enabled: Boolean(apiKey && model && validUrl),
    configError: !apiKey ? '未配置 LLM_API_KEY' : !model ? '未配置 LLM_MODEL' : !validUrl ? 'LLM_BASE_URL 必须为有效 HTTPS 地址' : null,
    timeoutMs: clampInt(env.LLM_TIMEOUT_MS, 25_000, 2_000, 60_000),
    maxTokens: clampInt(env.LLM_MAX_TOKENS, 600, 64, 1500),
    rateLimitPerMin: clampInt(env.AGENT_RATE_LIMIT_PER_MIN, 6, 1, 60),
    rateLimitPerHour: clampInt(env.AGENT_RATE_LIMIT_PER_HOUR, 30, 1, 500),
    dailyBudgetCalls: clampInt(env.AGENT_DAILY_BUDGET_CALLS, 200, 1, 10_000),
    maxConcurrent: clampInt(env.AGENT_MAX_CONCURRENT, 3, 1, 20),
  }
}

function isLoopbackAddress(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function extractClientIp(request) {
  const remote = request.socket?.remoteAddress || 'unknown'
  if (isLoopbackAddress(remote)) {
    const cfIp = String(request.headers['cf-connecting-ip'] || '').trim()
    if (cfIp) return cfIp
    const xff = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (xff) return xff
  }
  return remote
}

export function createRateLimiter({ perMin = 6, perHour = 30, dailyCap = 200, maxConcurrent = 3, nowFn = () => Date.now() } = {}) {
  const ipTimestamps = new Map()
  const ipInFlight = new Map()
  let globalInFlight = 0
  let dailyKey = ''
  let dailyCount = 0

  function currentUtcDay(nowMs) {
    return new Date(nowMs).toISOString().slice(0, 10)
  }

  function pruneStaleIps(nowMs) {
    if (ipTimestamps.size <= 1000) return
    const cutoff = nowMs - 3_600_000
    for (const [ip, list] of ipTimestamps.entries()) {
      const kept = list.filter(ts => ts > cutoff)
      if (kept.length === 0) ipTimestamps.delete(ip)
      else ipTimestamps.set(ip, kept)
    }
  }

  function acquire(ip) {
    const nowMs = nowFn()
    const day = currentUtcDay(nowMs)
    if (day !== dailyKey) {
      dailyKey = day
      dailyCount = 0
    }
    if (dailyCount >= dailyCap) {
      return { ok: false, status: 429, code: 'DAILY_BUDGET_EXCEEDED', message: '今日全站 AI 助手调用额度已达上限，请明天再试。', retryAfterSec: 3600 }
    }
    if (globalInFlight >= maxConcurrent) {
      return { ok: false, status: 429, code: 'SERVER_BUSY', message: 'AI 助手当前并发繁忙，请几秒后再试。', retryAfterSec: 5 }
    }
    if ((ipInFlight.get(ip) || 0) >= 1) {
      return { ok: false, status: 429, code: 'IP_CONCURRENT_LIMIT', message: '你有一条提问正在分析中，请等待本条回复完成后再发。', retryAfterSec: 3 }
    }
    const hourCutoff = nowMs - 3_600_000
    const minCutoff = nowMs - 60_000
    const history = (ipTimestamps.get(ip) || []).filter(ts => ts > hourCutoff)
    const recentMin = history.filter(ts => ts > minCutoff)
    if (recentMin.length >= perMin) {
      const retryAfterSec = Math.max(1, Math.ceil((recentMin[0] + 60_000 - nowMs) / 1000))
      return { ok: false, status: 429, code: 'RATE_LIMITED', message: `请求过于频繁（上限 ${perMin} 次/分钟），请 ${retryAfterSec} 秒后再试。`, retryAfterSec }
    }
    if (history.length >= perHour) {
      const retryAfterSec = Math.max(1, Math.ceil((history[0] + 3_600_000 - nowMs) / 1000))
      return { ok: false, status: 429, code: 'RATE_LIMITED', message: `本小时提问次数已达上限（${perHour} 次/小时），请稍后再试。`, retryAfterSec }
    }

    history.push(nowMs)
    ipTimestamps.set(ip, history)
    pruneStaleIps(nowMs)
    dailyCount += 1
    globalInFlight += 1
    ipInFlight.set(ip, (ipInFlight.get(ip) || 0) + 1)

    let released = false
    return {
      ok: true,
      release() {
        if (released) return
        released = true
        globalInFlight = Math.max(0, globalInFlight - 1)
        const next = (ipInFlight.get(ip) || 1) - 1
        if (next <= 0) ipInFlight.delete(ip)
        else ipInFlight.set(ip, next)
      },
    }
  }

  return { acquire }
}

function summarizeNumericSeries(values) {
  if (values.length === 0) return null
  let min = values[0]
  let max = values[0]
  let sum = 0
  for (const val of values) {
    if (val < min) min = val
    if (val > max) max = val
    sum += val
  }
  return {
    min: round2(min),
    max: round2(max),
    avg: round2(sum / values.length),
    first: round2(values[0]),
    last: round2(values[values.length - 1]),
    delta: round2(values[values.length - 1] - values[0]),
  }
}

function formatRow(row, nowMs) {
  if (!row) return null
  const capturedMs = Date.parse(row.captured_at)
  const receivedMs = Date.parse(row.received_at)
  const refMs = Number.isFinite(capturedMs) ? capturedMs : receivedMs
  const ageSeconds = Number.isFinite(refMs) ? Math.max(0, Math.round((nowMs - refMs) / 1000)) : null
  return {
    device_id: row.device_id,
    seq: row.seq,
    room_id: row.room_id,
    captured_at: row.captured_at,
    received_at: row.received_at,
    age_seconds: ageSeconds,
    stale: ageSeconds == null ? true : ageSeconds > STALE_THRESHOLD_SECONDS,
    simulated: Boolean(row.simulated),
    people_count: row.people_count ?? null,
    temperature_c: row.temperature_c,
    humidity_pct: row.humidity_pct,
    light_lux: row.light_lux ?? null,
    light_raw_u16: row.light_raw_u16 ?? null,
  }
}

export function createTelemetryTools(db, getBrokerState, nowFn = () => Date.now()) {
  const latestAnyStmt = db.prepare('SELECT * FROM telemetry_v2 ORDER BY received_at DESC, seq DESC LIMIT 1')
  const latestRealStmt = db.prepare('SELECT * FROM telemetry_v2 WHERE simulated = 0 ORDER BY received_at DESC, seq DESC LIMIT 1')
  const recentAllStmt = db.prepare('SELECT * FROM telemetry_v2 ORDER BY received_at DESC, seq DESC LIMIT ?')
  const recentRealStmt = db.prepare('SELECT * FROM telemetry_v2 WHERE simulated = 0 ORDER BY received_at DESC, seq DESC LIMIT ?')
  const windowAllStmt = db.prepare('SELECT * FROM telemetry_v2 WHERE received_at >= ? ORDER BY received_at ASC, seq ASC LIMIT 500')
  const windowRealStmt = db.prepare('SELECT * FROM telemetry_v2 WHERE simulated = 0 AND received_at >= ? ORDER BY received_at ASC, seq ASC LIMIT 500')
  const totalCountStmt = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN simulated = 0 THEN 1 ELSE 0 END) AS real_total FROM telemetry_v2')

  function computeDataBoundary() {
    const nowMs = nowFn()
    const latest = formatRow(latestAnyStmt.get(), nowMs)
    if (!latest) {
      return {
        has_data: false,
        simulated: false,
        stale: true,
        people_available: false,
        lux_calibrated: false,
        latest_seq: null,
      }
    }
    return {
      has_data: true,
      simulated: latest.simulated,
      stale: latest.stale,
      people_available: latest.people_count !== null,
      lux_calibrated: latest.light_lux !== null,
      latest_seq: latest.seq,
    }
  }

  function execute(name, rawArgs = {}, tracker = { seqs: new Set() }) {
    const nowMs = nowFn()
    const broker = getBrokerState()
    const addSeq = seq => {
      if (Number.isSafeInteger(seq) && tracker.seqs.size < 12) tracker.seqs.add(seq)
    }

    if (name === 'get_latest_telemetry') {
      const latest = formatRow(latestAnyStmt.get(), nowMs)
      const latestReal = formatRow(latestRealStmt.get(), nowMs)
      if (latest) addSeq(latest.seq)
      if (latestReal) addSeq(latestReal.seq)
      const result = {
        broker_connected: Boolean(broker.connected),
        topic: broker.topic,
        latest,
        latest_real: latest && !latest.simulated ? undefined : latestReal,
      }
      const summary = latest
        ? `${latest.simulated ? '模拟' : '实测'} #${latest.seq}（${latest.temperature_c}°C / ${latest.humidity_pct}% / ${latest.light_lux == null ? `${latest.light_raw_u16} ADC` : `${latest.light_lux} lx`}）`
        : '数据库暂无样本'
      return { result, summary }
    }

    if (name === 'get_recent_samples') {
      const limit = clampInt(rawArgs.limit, 15, 1, 50)
      const includeSimulated = Boolean(rawArgs.include_simulated)
      const rows = (includeSimulated ? recentAllStmt : recentRealStmt).all(limit).map(row => formatRow(row, nowMs))
      for (const row of rows.slice(0, 6)) addSeq(row.seq)
      return {
        result: { include_simulated: includeSimulated, count: rows.length, samples: rows },
        summary: `查询最近 ${rows.length} 条${includeSimulated ? '全部' : '实测'}样本`,
      }
    }

    if (name === 'get_telemetry_stats') {
      const windowMinutes = clampInt(rawArgs.window_minutes, 60, 5, 1440)
      const includeSimulated = Boolean(rawArgs.include_simulated)
      const cutoffIso = new Date(nowMs - windowMinutes * 60_000).toISOString()
      const rows = (includeSimulated ? windowAllStmt : windowRealStmt).all(cutoffIso)
      if (rows.length > 0) {
        addSeq(rows[rows.length - 1].seq)
        addSeq(rows[0].seq)
      }
      const temps = rows.map(r => r.temperature_c).filter(v => typeof v === 'number')
      const rhs = rows.map(r => r.humidity_pct).filter(v => typeof v === 'number')
      const adcs = rows.map(r => r.light_raw_u16).filter(v => typeof v === 'number')
      const luxs = rows.map(r => r.light_lux).filter(v => typeof v === 'number')
      const peopleRows = rows.filter(r => r.people_count != null).length
      const result = {
        window_minutes: windowMinutes,
        include_simulated: includeSimulated,
        sample_count: rows.length,
        first_seq: rows[0]?.seq ?? null,
        last_seq: rows[rows.length - 1]?.seq ?? null,
        first_received_at: rows[0]?.received_at ?? null,
        last_received_at: rows[rows.length - 1]?.received_at ?? null,
        temperature_c: summarizeNumericSeries(temps),
        humidity_pct: summarizeNumericSeries(rhs),
        light_raw_u16: summarizeNumericSeries(adcs),
        light_lux: summarizeNumericSeries(luxs),
        people_count_available_rows: peopleRows,
      }
      const summary = rows.length
        ? `近 ${windowMinutes} 分钟共 ${rows.length} 条（#${result.first_seq}–#${result.last_seq}）`
        : `近 ${windowMinutes} 分钟暂无${includeSimulated ? '' : '实测'}样本`
      return { result, summary }
    }

    if (name === 'get_device_health') {
      const sampleLimit = clampInt(rawArgs.sample_limit, 20, 2, 50)
      const counts = totalCountStmt.get()
      const realRows = recentRealStmt.all(sampleLimit).map(row => formatRow(row, nowMs))
      const targetRows = realRows.length > 0 ? realRows : recentAllStmt.all(sampleLimit).map(row => formatRow(row, nowMs))
      if (targetRows[0]) addSeq(targetRows[0].seq)
      const intervals = []
      for (let i = 0; i + 1 < targetRows.length; i += 1) {
        const newer = Date.parse(targetRows[i].received_at)
        const older = Date.parse(targetRows[i + 1].received_at)
        if (Number.isFinite(newer) && Number.isFinite(older) && newer >= older) {
          intervals.push(round2((newer - older) / 1000))
        }
      }
      const latest = targetRows[0] || null
      const result = {
        broker_connected: Boolean(broker.connected),
        topic: broker.topic,
        total_stored_samples: counts?.total || 0,
        real_stored_samples: counts?.real_total || 0,
        inspected_real_only: realRows.length > 0,
        inspected_count: targetRows.length,
        latest_seq: latest?.seq ?? null,
        latest_age_seconds: latest?.age_seconds ?? null,
        is_stale: latest ? latest.stale : true,
        interval_seconds: intervals.length
          ? {
              avg: round2(intervals.reduce((a, b) => a + b, 0) / intervals.length),
              min: Math.min(...intervals),
              max: Math.max(...intervals),
            }
          : null,
        hardware_capabilities: {
          aht20_temperature_humidity: '已实测接入（板载 AHT20）',
          ldr_pc5_light_adc: '已实测接入（仅 16 位 ADC 原码，尚未标定 lx）',
          light_lux_calibration: latest?.light_lux != null ? '已标定 lx' : '未标定（light_lux 为 null）',
          k230_people_count: latest?.people_count != null ? '已接入' : '尚未接入（people_count 为 null）',
          ac_actuator_control: '未接入（仅提供只读分析与建议，不执行控制下发）',
        },
      }
      const summary = latest
        ? `Broker ${broker.connected ? '在线' : '断开'} · 最新 #${latest.seq}（${latest.age_seconds}s 前）`
        : `Broker ${broker.connected ? '在线' : '断开'} · 暂无样本`
      return { result, summary }
    }

    return {
      result: { error: `未知工具：${name}` },
      summary: `未知工具 ${name}`,
    }
  }

  return { execute, computeDataBoundary }
}

function looksLikeToolsUnsupported(status, rawText) {
  if (status !== 400 && status !== 422) return false
  return /tool|function_call|functions?.*not support/i.test(rawText || '')
}

function safeJsonParse(raw) {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function createAgentHandler({ db, getBrokerState, env = process.env, fetchImpl = fetch, nowFn = () => Date.now() }) {
  const config = readAgentConfig(env)
  const tools = createTelemetryTools(db, getBrokerState, nowFn)
  const limiter = createRateLimiter({
    perMin: config.rateLimitPerMin,
    perHour: config.rateLimitPerHour,
    dailyCap: config.dailyBudgetCalls,
    maxConcurrent: config.maxConcurrent,
    nowFn,
  })

  async function callChatCompletions(messages, { withTools }) {
    const endpoint = `${config.baseUrl}/chat/completions`
    const payload = {
      model: config.model,
      messages,
      temperature: 0.2,
      max_tokens: config.maxTokens,
    }
    if (withTools) {
      payload.tools = TOOL_DEFINITIONS
      payload.tool_choice = 'auto'
    }
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.timeoutMs),
      })
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        const err = new Error('上游模型响应超时，请稍后重试。')
        err.status = 504
        err.code = 'LLM_TIMEOUT'
        throw err
      }
      const err = new Error('无法连接上游大模型接口，请稍后重试。')
      err.status = 502
      err.code = 'LLM_NETWORK_ERROR'
      throw err
    }

    const text = await response.text()
    if (!response.ok) {
      const err = new Error(`上游模型接口返回 HTTP ${response.status}`)
      err.status = response.status === 429 ? 429 : 502
      err.code = response.status === 429 ? 'LLM_UPSTREAM_RATE_LIMIT' : 'LLM_UPSTREAM_ERROR'
      err.upstreamStatus = response.status
      err.upstreamBody = text.slice(0, 300)
      throw err
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      const err = new Error('上游模型返回了无法解析的响应格式。')
      err.status = 502
      err.code = 'LLM_INVALID_JSON'
      throw err
    }
    return json
  }

  function getStatus() {
    return {
      enabled: config.enabled,
      provider: config.provider,
      model: config.enabled ? config.model : null,
      reason: config.enabled ? null : config.configError,
      presets: Object.values(AGENT_PRESETS).map(({ id, label }) => ({ id, label })),
      rate_limit: {
        per_min: config.rateLimitPerMin,
        per_hour: config.rateLimitPerHour,
        daily_cap: config.dailyBudgetCalls,
      },
    }
  }

  async function ask({ question = '', preset = '', clientIp = 'unknown' } = {}) {
    if (!config.enabled) {
      return {
        status: 503,
        body: { error: 'AGENT_NOT_CONFIGURED', message: '后端尚未配置大模型 API Key，遥测看板仍可正常只读查看。' },
      }
    }

    const presetObj = preset && Object.prototype.hasOwnProperty.call(AGENT_PRESETS, preset) ? AGENT_PRESETS[preset] : null
    if (preset && !presetObj) {
      return { status: 400, body: { error: 'INVALID_PRESET', message: '未知的快捷诊断类型。' } }
    }
    const cleanQuestion = String(question || '').trim() || presetObj?.question || ''
    if (!cleanQuestion) {
      return { status: 400, body: { error: 'INVALID_QUESTION', message: '请输入问题或选择一个快捷诊断按钮。' } }
    }
    if (cleanQuestion.length > MAX_QUESTION_CHARS) {
      return {
        status: 400,
        body: { error: 'QUESTION_TOO_LONG', message: `单次提问不能超过 ${MAX_QUESTION_CHARS} 字。` },
      }
    }

    const slot = limiter.acquire(clientIp)
    if (!slot.ok) {
      return {
        status: slot.status,
        headers: { 'Retry-After': String(slot.retryAfterSec) },
        body: { error: slot.code, message: slot.message, retry_after_sec: slot.retryAfterSec },
      }
    }

    const startedAt = nowFn()
    const tracker = { seqs: new Set() }
    const toolsUsed = []
    let promptTokens = 0
    let completionTokens = 0
    let mode = 'tool_calling'

    try {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: cleanQuestion },
      ]

      let completion
      try {
        completion = await callChatCompletions(messages, { withTools: true })
      } catch (error) {
        if (looksLikeToolsUnsupported(error.upstreamStatus, error.upstreamBody)) {
          mode = 'context_fallback'
          const preloaded = [
            ['get_latest_telemetry', {}],
            ['get_telemetry_stats', { window_minutes: 60 }],
            ['get_device_health', { sample_limit: 20 }],
          ].map(([toolName, toolArgs]) => {
            const out = tools.execute(toolName, toolArgs, tracker)
            toolsUsed.push({ name: toolName, args: toolArgs, summary: out.summary })
            return { tool: toolName, result: out.result }
          })
          const fallbackMessages = [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `以下是服务端刚刚从 SQLite 实查的最新事实数据（JSON）：\n${JSON.stringify(preloaded)}\n\n请严格依据上述数据回答用户问题：${cleanQuestion}`,
            },
          ]
          completion = await callChatCompletions(fallbackMessages, { withTools: false })
        } else {
          throw error
        }
      }

      const addUsage = res => {
        promptTokens += Number(res?.usage?.prompt_tokens || 0)
        completionTokens += Number(res?.usage?.completion_tokens || 0)
      }
      addUsage(completion)

      let rounds = 0
      while (mode === 'tool_calling') {
        const message = completion?.choices?.[0]?.message
        const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
        if (calls.length === 0) break

        messages.push({
          role: 'assistant',
          content: message.content ?? null,
          tool_calls: calls,
        })

        for (const call of calls) {
          const toolName = call?.function?.name || ''
          const toolArgs = safeJsonParse(call?.function?.arguments)
          const { result, summary } = tools.execute(toolName, toolArgs, tracker)
          toolsUsed.push({ name: toolName, args: toolArgs, summary })
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          })
        }

        rounds += 1
        const allowMoreTools = rounds < MAX_TOOL_ROUNDS
        if (!allowMoreTools) {
          messages.push({ role: 'user', content: '请直接基于以上工具查询结果给出最终中文答复，不要再调用工具。' })
        }
        completion = await callChatCompletions(messages, { withTools: allowMoreTools })
        addUsage(completion)
        if (!allowMoreTools) break
      }

      const answer = String(completion?.choices?.[0]?.message?.content || '').trim()
      if (!answer) {
        return {
          status: 502,
          body: { error: 'EMPTY_LLM_REPLY', message: '模型未返回有效文本内容，请稍后重试。' },
        }
      }

      return {
        status: 200,
        body: {
          answer,
          provider: config.provider,
          model: config.model,
          mode,
          tools_used: toolsUsed,
          referenced_seqs: [...tracker.seqs],
          data_boundary: tools.computeDataBoundary(),
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
          },
          latency_ms: Math.max(0, nowFn() - startedAt),
        },
      }
    } catch (error) {
      return {
        status: error.status || 502,
        body: {
          error: error.code || 'LLM_UPSTREAM_ERROR',
          message: error.message || 'AI 助手调用失败，请稍后重试。',
        },
      }
    } finally {
      slot.release()
    }
  }

  return { getStatus, ask }
}

function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let done = false
    request.on('data', chunk => {
      if (done) return
      total += chunk.length
      if (total > maxBytes) {
        done = true
        const err = new Error(`请求体超过 ${maxBytes} 字节上限`)
        err.status = 413
        err.code = 'PAYLOAD_TOO_LARGE'
        reject(err)
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (done) return
      done = true
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        const parsed = raw ? JSON.parse(raw) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('请求体必须为 JSON 对象')
          err.status = 400
          err.code = 'INVALID_JSON'
          reject(err)
          return
        }
        resolve(parsed)
      } catch {
        const err = new Error('无法解析请求 JSON')
        err.status = 400
        err.code = 'INVALID_JSON'
        reject(err)
      }
    })
    request.on('error', () => {
      if (done) return
      done = true
      const err = new Error('读取请求体失败')
      err.status = 400
      err.code = 'READ_ERROR'
      reject(err)
    })
  })
}

function writeJson(response, status, headers, payload) {
  response.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

export async function handleAgentRoute(request, response, { path, agent, allowedOrigins }) {
  if (path === '/api/agent/status') {
    const cors = corsHeaders(request.headers.origin, allowedOrigins, 'GET, OPTIONS')
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors)
      response.end()
      return true
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { ...cors, Allow: 'GET, OPTIONS' })
      response.end('Method not allowed')
      return true
    }
    writeJson(response, 200, cors, agent.getStatus())
    return true
  }

  if (path === '/api/agent') {
    const origin = request.headers.origin
    const cors = corsHeaders(origin, allowedOrigins, 'POST, OPTIONS')
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors)
      response.end()
      return true
    }
    if (!isOriginAllowed(origin, allowedOrigins)) {
      writeJson(response, 403, cors, { error: 'ORIGIN_NOT_ALLOWED', message: '不允许的请求来源。' })
      return true
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { ...cors, Allow: 'POST, OPTIONS' })
      response.end('Method not allowed')
      return true
    }
    const contentType = String(request.headers['content-type'] || '')
    if (!contentType.toLowerCase().includes('application/json')) {
      writeJson(response, 415, cors, { error: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type 必须为 application/json。' })
      return true
    }

    let body
    try {
      body = await readJsonBody(request, MAX_BODY_BYTES)
    } catch (error) {
      writeJson(response, error.status || 400, cors, { error: error.code || 'BAD_REQUEST', message: error.message })
      return true
    }

    const result = await agent.ask({
      question: body.question,
      preset: body.preset,
      clientIp: extractClientIp(request),
    })
    writeJson(response, result.status, { ...cors, ...(result.headers || {}) }, result.body)
    return true
  }

  return false
}
