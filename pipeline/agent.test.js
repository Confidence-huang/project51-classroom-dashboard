/* 验证网页 LLM Agent 的 SQLite Tool-Calling、防编造边界、CORS、限流与降级回退。 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createAgentHandler, handleAgentRoute } from './agent.js'
import { parseAllowedOrigins } from './http-policy.js'

function createSeededDb(nowMs) {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE telemetry_v2 (
    device_id TEXT NOT NULL, seq INTEGER NOT NULL, room_id TEXT NOT NULL,
    captured_at TEXT NOT NULL, received_at TEXT NOT NULL, simulated INTEGER NOT NULL,
    people_count INTEGER, temperature_c REAL NOT NULL,
    humidity_pct REAL NOT NULL, light_lux REAL, light_raw_u16 INTEGER,
    PRIMARY KEY(device_id, seq)
  )`)
  const insert = db.prepare('INSERT INTO telemetry_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const t1 = new Date(nowMs - 24_000).toISOString()
  const t2 = new Date(nowMs - 12_000).toISOString()
  const t3 = new Date(nowMs - 4_000).toISOString()
  insert.run('nucleo-f413zh-board01', 848323093, 'room01', t1, t1, 0, null, 27.0, 30.0, null, 16500)
  insert.run('nucleo-f413zh-board01', 848323103, 'room01', t2, t2, 0, null, 27.2, 29.5, null, 16700)
  insert.run('nucleo-f413zh-board01', 848323113, 'room01', t3, t3, 0, null, 27.4, 29.0, null, 16900)
  return db
}

async function startServer(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('完成真实 OpenAI 兼容多轮 Tool-Calling 并准确返回数据边界', async () => {
  const nowMs = Date.parse('2026-11-18T13:30:00.000Z')
  const db = createSeededDb(nowMs)
  const seenRequests = []

  const mockLlm = await startServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      assert.equal(req.url, '/v1/chat/completions')
      assert.equal(req.headers.authorization, 'Bearer test-secret-key')
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      seenRequests.push(body)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (seenRequests.length === 1) {
        assert.ok(Array.isArray(body.tools) && body.tools.length === 4)
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'get_latest_telemetry', arguments: '{}' } },
                { id: 'call_2', type: 'function', function: { name: 'get_telemetry_stats', arguments: '{"window_minutes":60}' } },
              ],
            },
          }],
          usage: { prompt_tokens: 300, completion_tokens: 40 },
        }))
        return
      }

      const toolMessages = body.messages.filter(m => m.role === 'tool')
      assert.equal(toolMessages.length, 2)
      const latestPayload = JSON.parse(toolMessages[0].content)
      const statsPayload = JSON.parse(toolMessages[1].content)
      assert.equal(latestPayload.latest.seq, 848323113)
      assert.equal(latestPayload.latest.people_count, null)
      assert.equal(latestPayload.latest.light_lux, null)
      assert.equal(latestPayload.latest.light_raw_u16, 16900)
      assert.equal(statsPayload.sample_count, 3)
      assert.equal(statsPayload.temperature_c.avg, 27.2)

      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '根据最新板端实测样本 #848323113，当前温度 27.4 °C、湿度 29%，光敏仅 16900 ADC（未标定 lx），K230 人数尚未接入。',
          },
        }],
        usage: { prompt_tokens: 520, completion_tokens: 68 },
      }))
    })
  })

  try {
    const agent = createAgentHandler({
      db,
      getBrokerState: () => ({ connected: true, topic: 'classroom/room01/telemetry' }),
      env: {
        LLM_PROVIDER: 'deepseek',
        LLM_BASE_URL: `${mockLlm.baseUrl}/v1`,
        LLM_MODEL: 'deepseek-chat',
        LLM_API_KEY: 'test-secret-key',
      },
      nowFn: () => nowMs,
    })

    const res = await agent.ask({ preset: 'diagnose', clientIp: '203.0.113.10' })
    assert.equal(res.status, 200)
    assert.equal(res.body.mode, 'tool_calling')
    assert.equal(res.body.model, 'deepseek-chat')
    assert.equal(res.body.tools_used.length, 2)
    assert.ok(res.body.referenced_seqs.includes(848323113))
    assert.ok(res.body.referenced_seqs.includes(848323093))
    assert.deepEqual(res.body.data_boundary, {
      has_data: true,
      simulated: false,
      stale: false,
      people_available: false,
      lux_calibrated: false,
      latest_seq: 848323113,
    })
    assert.equal(res.body.usage.prompt_tokens, 820)
    assert.equal(res.body.usage.completion_tokens, 108)
  } finally {
    await mockLlm.close()
    db.close()
  }
})

test('上游模型不支持 tools 时自动走服务端预查上下文降级', async () => {
  const nowMs = Date.parse('2026-11-18T13:30:00.000Z')
  const db = createSeededDb(nowMs)
  let calls = 0

  const mockLlm = await startServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      calls += 1
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (calls === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'tools are not supported by this model' } }))
        return
      }
      assert.equal(body.tools, undefined)
      assert.ok(body.messages[1].content.includes('848323113'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '依据样本 #848323113，当前温度 27.4 °C，K230 人数未接入。' } }],
        usage: { prompt_tokens: 210, completion_tokens: 30 },
      }))
    })
  })

  try {
    const agent = createAgentHandler({
      db,
      getBrokerState: () => ({ connected: true, topic: 'classroom/room01/telemetry' }),
      env: {
        LLM_PROVIDER: 'custom',
        LLM_BASE_URL: `${mockLlm.baseUrl}/v1`,
        LLM_MODEL: 'lite-no-tools',
        LLM_API_KEY: 'k',
      },
      nowFn: () => nowMs,
    })
    const res = await agent.ask({ question: '教室现在温度多少？', clientIp: '198.51.100.2' })
    assert.equal(res.status, 200)
    assert.equal(res.body.mode, 'context_fallback')
    assert.equal(res.body.tools_used.length, 3)
    assert.ok(res.body.referenced_seqs.includes(848323113))
  } finally {
    await mockLlm.close()
    db.close()
  }
})

test('未配置 Key 时返回 503 且状态接口优雅提示不报错', async () => {
  const nowMs = Date.parse('2026-11-18T13:30:00.000Z')
  const db = createSeededDb(nowMs)
  const agent = createAgentHandler({
    db,
    getBrokerState: () => ({ connected: true, topic: 'classroom/room01/telemetry' }),
    env: {},
    nowFn: () => nowMs,
  })
  const allowed = parseAllowedOrigins('https://confidence-huang.github.io')
  const api = await startServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const handled = await handleAgentRoute(req, res, { path, agent, allowedOrigins: allowed })
    if (!handled) { res.writeHead(404); res.end('Not found') }
  })

  try {
    const statusRes = await fetch(`${api.baseUrl}/api/agent/status`, {
      headers: { Origin: 'https://confidence-huang.github.io' },
    })
    assert.equal(statusRes.status, 200)
    assert.equal(statusRes.headers.get('access-control-allow-origin'), 'https://confidence-huang.github.io')
    const statusJson = await statusRes.json()
    assert.equal(statusJson.enabled, false)

    const askRes = await fetch(`${api.baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://confidence-huang.github.io' },
      body: JSON.stringify({ preset: 'diagnose' }),
    })
    assert.equal(askRes.status, 503)
    const askJson = await askRes.json()
    assert.equal(askJson.error, 'AGENT_NOT_CONFIGURED')
  } finally {
    await api.close()
    db.close()
  }
})

test('HTTP 路由强制校验 Origin、方法、Body 上限与按 CF-Connecting-IP 限流', async () => {
  const nowMs = Date.parse('2026-11-18T13:30:00.000Z')
  const db = createSeededDb(nowMs)
  const mockLlm = await startServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '测试回复。' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }))
    })
  })

  const agent = createAgentHandler({
    db,
    getBrokerState: () => ({ connected: true, topic: 'classroom/room01/telemetry' }),
    env: {
      LLM_PROVIDER: 'deepseek',
      LLM_BASE_URL: `${mockLlm.baseUrl}/v1`,
      LLM_MODEL: 'deepseek-chat',
      LLM_API_KEY: 'secret',
      AGENT_RATE_LIMIT_PER_MIN: '2',
      AGENT_DAILY_BUDGET_CALLS: '3',
    },
    nowFn: () => nowMs,
  })
  const allowed = parseAllowedOrigins('https://confidence-huang.github.io')
  const api = await startServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const handled = await handleAgentRoute(req, res, { path, agent, allowedOrigins: allowed })
    if (!handled) { res.writeHead(404); res.end('Not found') }
  })

  try {
    // 非白名单 Origin 被 403 拒绝
    const evilRes = await fetch(`${api.baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ question: 'hi' }),
    })
    assert.equal(evilRes.status, 403)
    assert.equal(evilRes.headers.get('access-control-allow-origin'), null)

    // GET /api/agent 返回 405
    const getRes = await fetch(`${api.baseUrl}/api/agent`)
    assert.equal(getRes.status, 405)

    // 超大 Body 返回 413
    const hugeRes = await fetch(`${api.baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://confidence-huang.github.io' },
      body: JSON.stringify({ question: 'x'.repeat(5000) }),
    })
    assert.equal(hugeRes.status, 413)

    // 超长问题 (>300字) 返回 400
    const longRes = await fetch(`${api.baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://confidence-huang.github.io' },
      body: JSON.stringify({ question: '问'.repeat(301) }),
    })
    assert.equal(longRes.status, 400)

    // 按 CF-Connecting-IP 独立限流：IP A 第 1、2 次通过，第 3 次 429
    for (let i = 0; i < 2; i += 1) {
      const okRes = await fetch(`${api.baseUrl}/api/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://confidence-huang.github.io', 'CF-Connecting-IP': '198.51.100.11' },
        body: JSON.stringify({ question: '教室温度？' }),
      })
      assert.equal(okRes.status, 200)
    }
    const limitedA = await fetch(`${api.baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://confidence-huang.github.io', 'CF-Connecting-IP': '198.51.100.11' },
      body: JSON.stringify({ question: '教室温度？' }),
    })
    assert.equal(limitedA.status, 429)
    assert.ok(Number(limitedA.headers.get('retry-after')) >= 1)

    // IP B 不受 IP A 影响，第 1 次成功（同时消耗全站第 3/3 次日额度）
    const okB = await fetch(`${api.baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://confidence-huang.github.io', 'CF-Connecting-IP': '198.51.100.22' },
      body: JSON.stringify({ question: '教室湿度？' }),
    })
    assert.equal(okB.status, 200)

    // 全站每日预算耗尽后，新 IP C 返回 DAILY_BUDGET_EXCEEDED
    const budgetHit = await fetch(`${api.baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://confidence-huang.github.io', 'CF-Connecting-IP': '198.51.100.33' },
      body: JSON.stringify({ question: '光照？' }),
    })
    assert.equal(budgetHit.status, 429)
    const budgetJson = await budgetHit.json()
    assert.equal(budgetJson.error, 'DAILY_BUDGET_EXCEEDED')
  } finally {
    await api.close()
    await mockLlm.close()
    db.close()
  }
})
