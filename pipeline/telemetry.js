/*
智慧教室模拟数据的唯一格式来源。
这里生成与未来 STM32 固件约定的完整快照；所有数值都明确标记为模拟。
运行方式：由 publish.js 按序号调用 sample(seq)，然后经 MQTT 发布 JSON。
*/

// --- 按序号构造一条可重复核对的模拟快照 ---
export function sample(seq, runID) {
  return {
    schema_version: 1,                 // 协议版本，用于将来升级字段。
    type: 'telemetry',                 // 看板只用此类型更新四项读数。
    source: 'stm32_sim',               // 明确表明是电脑模拟 STM32。
    simulated: true,                   // 不让模拟值混入真实采集结论。
    device_id: `nucleo-f413zh-sim-${runID}`, // 每次演示独立身份，重跑时序号不会撞历史库。
    room_id: 'room01',                  // 与 MQTT 主题中的教室一致。
    seq,                               // 单调递增序号，用于逐段核对与去重。
    captured_at: new Date().toISOString(), // 模拟采样时间，UTC ISO 8601。
    people_count: 2 + seq % 3,        // 模拟识别人数，单位人。
    temperature_c: 24 + seq % 4,      // 模拟温度，单位 °C。
    humidity_pct: 45 + seq % 6,       // 模拟相对湿度，单位 %。
    light_lux: 300 + seq * 10,        // 模拟照度，单位 lx。
  }
}

// --- MQTT 消息进入数据库前只在边界校验一次 ---
export function read(bytes) {
  const data = JSON.parse(bytes.toString())
  if (data?.schema_version !== 1 || data?.type !== 'telemetry') throw new Error('协议版本或消息类型不符')
  if (typeof data.device_id !== 'string' || !data.device_id || typeof data.room_id !== 'string') throw new Error('设备身份不完整')
  if (!Number.isSafeInteger(data.seq) || data.seq < 0 || typeof data.simulated !== 'boolean') throw new Error('序号或模拟标记不正确')
  if (Number.isNaN(Date.parse(data.captured_at))) throw new Error('采样时间不正确')
  for (const field of ['temperature_c', 'humidity_pct']) {
    if (typeof data[field] !== 'number' || !Number.isFinite(data[field])) throw new Error(`${field} 不是有限数值`)
  }
  if (data.people_count !== null && (!Number.isInteger(data.people_count) || data.people_count < 0)) throw new Error('人数不正确')
  const calibrated = typeof data.light_lux === 'number' && Number.isFinite(data.light_lux)
  const raw = data.light_lux === null && Number.isInteger(data.light_raw_u16) && data.light_raw_u16 >= 0 && data.light_raw_u16 <= 65535
  if (!calibrated && !raw) throw new Error('光照缺少有效的 lx 或 ADC 原码')
  if (data.simulated && (data.people_count === null || !calibrated)) throw new Error('模拟格式缺少完整读数')
  return data
}
