/* 验证新板载实测格式与旧模拟格式共存，防止 ADC 原码被误当 lx。 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { read, sample } from './telemetry.js'

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
