/* 验证新板载实测格式与旧模拟格式共存，防止 ADC 原码被误当 lx。 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { read, sample } from './telemetry.js'
import { corsHeaders, parseAllowedOrigins } from './http-policy.js'

test('仅对白名单前端源返回只读 CORS 头', () => {
  const allowed = parseAllowedOrigins('https://confidence-huang.github.io/, http://127.0.0.1:5173')
  const matched = corsHeaders('https://confidence-huang.github.io', allowed)
  assert.equal(matched['Access-Control-Allow-Origin'], 'https://confidence-huang.github.io')
  assert.equal(matched['Access-Control-Allow-Methods'], 'GET, OPTIONS')
  assert.equal(matched.Vary, 'Origin')
  const rejected = corsHeaders('https://evil.example', allowed)
  assert.equal(rejected['Access-Control-Allow-Origin'], undefined)
  assert.equal(rejected.Vary, 'Origin')
})

test('保留旧模拟载荷的 lx 数值', () => {
  const data = sample(1, 'contract')
  assert.equal(read(Buffer.from(JSON.stringify(data))).light_lux, data.light_lux)
})

test('允许板载 AHT20 与未标定的光敏 ADC', () => {
  const data = { ...sample(2, 'contract'), source: 'stm32_micropython_aht20_ldr',
    simulated: false, people_count: null, light_lux: null, light_raw_u16: 22917 }
  assert.equal(read(Buffer.from(JSON.stringify(data))).light_raw_u16, 22917)
  assert.throws(() => read(Buffer.from(JSON.stringify({ ...data, light_raw_u16: 90000 }))))
})

test('支持 SGP30 空气质量与外接 BH1750 lx 字段', () => {
  const data = {
    ...sample(3, 'sgp30'),
    simulated: false,
    people_count: 1,
    light_lux: 10.83,
    light_raw_u16: 22000,
    air_valid: true,
    air_status: 0,
    eco2_ppm: 412,
    tvoc_ppb: 8,
  }
  const parsed = read(Buffer.from(JSON.stringify(data)))
  assert.equal(parsed.air_valid, true)
  assert.equal(parsed.eco2_ppm, 412)
  assert.equal(parsed.tvoc_ppb, 8)
})
