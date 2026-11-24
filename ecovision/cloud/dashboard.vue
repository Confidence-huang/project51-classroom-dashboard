<template>
  <section class="eco" v-if="msg && msg.payload">
    <header><h1>EcoVision 绿智微视</h1><p>设备控制</p></header>
    <p role="alert" v-if="msg.payload.error">请求未发送：{{ msg.payload.error }}</p>
    <article v-for="d in msg.payload.devices" :key="d.device_id">
      <h2>{{ d.device_id }} <strong v-if="d.simulated">模拟设备 · 非硬件实测</strong></h2>
      <p>连接：{{ stale(d) ? 'STALE' : d.connection }} · 最后接收（UTC）：{{ d.last_received_at || '尚无数据' }}</p>
      <p v-if="stale(d)" role="alert">数据已过期或尚无新鲜遥测，控制已禁用。</p>
      <div class="values" v-if="d.telemetry">
        <span>人数 <b>{{ d.telemetry.vision_valid ? d.telemetry.count : '无效' }}</b></span>
        <span>温度 <b>{{ d.telemetry.temp_valid ? d.telemetry.temp_c + ' °C' : '无效' }}</b></span>
        <span>湿度 <b>{{ d.telemetry.humidity_valid ? d.telemetry.humidity_pct + ' %RH' : '无效' }}</b></span>
        <span>占用 {{ d.telemetry.occupancy }}</span><span>模式 {{ d.telemetry.mode }}</span>
        <span>风扇 {{ fanLabel(d.telemetry) }} / 灯环 {{ lampLabel(d.telemetry.led_out) }}</span>
        <span v-if="d.telemetry.mode === 'REMOTE'">{{ d.telemetry.hold_remaining_s }} 秒后恢复自动</span>
        <span>健康 {{ d.telemetry.faults.join(', ') || '无已报故障' }}</span>
        <span>可信时间 {{ d.telemetry.time_valid ? '是' : '否' }} / epoch {{ d.telemetry.control_epoch }}</span>
      </div>
      <form v-if="d.telemetry" :key="d.telemetry.boot_id" @submit.prevent="apply(d, $event)">
        <fieldset :disabled="!d.can_control || !socketReady() || stale(d) || waiting(d.device_id)">
          <legend>手动控制（本地关闭优先）</legend>
          <label>风扇
            <select name="fan" :value="selection(d, 'fan') ?? d.telemetry.fan_level ?? d.telemetry.fan_out" @change="select(d, 'fan', $event)">
              <option value="0">关闭</option>
              <template v-if="d.telemetry.fan_level !== undefined">
                <option v-for="level in msg.payload.fan_level_max" :key="level" :value="level">{{ level }} 档</option>
              </template>
              <option v-else value="1">开启</option>
            </select>
          </label>
          <label>灯环
            <select name="lamp" :value="selection(d, 'lamp') ?? d.telemetry.led_out" @change="select(d, 'lamp', $event)">
              <option value="0">灭</option>
              <option value="1">亮</option>
            </select>
          </label>
          <button type="submit">应用手动设置</button>
          <button type="button" @click="request(d, { mode: 'AUTO' })">恢复自动模式</button>
        </fieldset>
        <p>手动设置保持 {{ msg.payload.hold_default_s }} 秒，到期恢复自动模式。</p>
      </form>
      <p v-if="waiting(d.device_id)">PENDING · 待终端确认，尚不能认定执行成功</p>
      <p v-if="d.telemetry && d.telemetry.mode === 'LOCAL_OFF'">终端本地关闭锁定，请在设备上短按解除。</p>
    </article>
    <h2>命令记录</h2><p>TIMEOUT = 10秒未收到 ACK，结果未知。已确认表示输出逻辑写入，不证明风扇机械转动。</p>
    <div class="history"><table><thead><tr><th>命令 ID / 设备</th><th>请求</th><th>结果</th></tr></thead>
      <tbody><tr v-for="r in msg.payload.commands.slice(0, 20)" :key="r.command.cmd_id">
        <td>{{ r.command.cmd_id }}<br>{{ r.command.device_id }}</td>
        <td>{{ r.command.mode === 'AUTO' ? '恢复自动' : '风扇 ' + fanLabel(r.command) + ' / 灯环 ' + lampLabel(r.command.led_out) }}</td>
        <td>{{ label(effectiveState(r)) }} {{ r.reason || '' }} {{ r.late ? '（迟到 ACK）' : '' }}</td>
      </tr></tbody></table></div>
  </section>
</template>
<script>
export default {
  data() { return { drafts: {}, submitting: {}, tick: performance.now(), received: performance.now(), timer: null } },
  watch: { msg() { this.received = performance.now() } },
  mounted() { this.timer = setInterval(() => { this.tick = performance.now() }, 500) },
  unmounted() { clearInterval(this.timer) },
  methods: {
    socketReady() { return this.$socket && this.$socket.connected },
    effectiveState(r) { return r.state === 'PENDING' && Math.max(0, this.tick - this.received) >= r.ack_remaining_ms ? 'TIMEOUT' : r.state },
    stale(d) { return d.age_ms === null || d.age_ms + Math.max(0, this.tick - this.received) >= 15000 },
    label(s) { return ({PENDING:'PENDING · 待确认', APPLIED:'APPLIED · 已确认', REJECTED:'REJECTED · 终端拒绝', TIMEOUT:'TIMEOUT · 结果未知'})[s] || s },
    waiting(id) { return this.tick - (this.submitting[id] ?? -10000) < 1500 || this.msg.payload.commands.some(r => r.command.device_id === id && this.effectiveState(r) === 'PENDING') },
    fanLabel(setting) {
      if (setting.fan_level !== undefined) return setting.fan_level ? setting.fan_level + ' 档' : '关闭'
      return setting.fan_out ? '开启' : '关闭'
    },
    lampLabel(output) { return output ? '亮' : '灭' },
    selection(device, field) {
      const draft = this.drafts[device.device_id]
      return draft?.boot === device.telemetry.boot_id ? draft[field] : undefined
    },
    select(device, field, event) {
      // Keep selections through telemetry refreshes and discard them when the device reboots.
      const draft = this.drafts[device.device_id]
      const boot = device.telemetry.boot_id
      const previous = draft?.boot === boot ? draft : { boot }
      this.drafts[device.device_id] = { ...previous, [field]: Number(event.target.value) }
    },
    apply(device, event) {
      // Submit both absolute settings together so each request has a single device ACK.
      const values = new FormData(event.currentTarget)
      const fan = Number(values.get('fan'))
      const intent = { mode: 'REMOTE', fan_out: Number(fan > 0), led_out: Number(values.get('lamp')) }
      if (device.telemetry.fan_level !== undefined) intent.fan_level = fan
      this.request(device, intent)
    },
    request(device, intent) {
      const id = device.device_id
      if (!this.socketReady() || !device.can_control || this.stale(device) || this.waiting(id)) return

      delete this.drafts[id]
      this.submitting[id] = performance.now()
      this.send({ payload: { device_id: id, intent } })
    }
  }
}
</script>
<style>
.eco { max-width:1100px; margin:auto; color:#163e34; padding:12px; font-family:system-ui,sans-serif }
.eco header { border-bottom:3px solid #247d62; margin-bottom:18px }
.eco article { padding:20px; margin:14px 0; border:1px solid #9bbbaf; border-radius:10px; background:#f4faf6 }
.eco strong { display:inline-block; background:#fff0bb; color:#684c00; font-size:16px; padding:5px 9px }
.eco .values { display:flex; gap:18px; flex-wrap:wrap; padding:16px 0 }
.eco fieldset { display:flex; flex-wrap:wrap; gap:12px; padding:15px }
.eco button { background:#17684f; color:white; padding:10px 16px; border:0; border-radius:5px; cursor:pointer }
.eco fieldset label { display:flex; align-items:center; gap:8px }
.eco select { font:inherit; color:inherit; background:white; border:1px solid #729b8b; border-radius:5px; padding:8px }
.eco fieldset:disabled { opacity:.45 }
.eco .history { overflow:auto } .eco table { width:100%; border-collapse:collapse } .eco td,.eco th { border-bottom:1px solid #bbcfc5; padding:10px; text-align:left; overflow-wrap:anywhere }
</style>
