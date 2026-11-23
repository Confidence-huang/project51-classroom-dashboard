<template>
  <section class="eco" v-if="msg && msg.payload">
    <header><h1>EcoVision 绿智微视</h1><p>远程风扇控制</p></header>
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
        <span>风扇输出 {{ d.telemetry.fan_out }} / LED输出 {{ d.telemetry.led_out }}</span>
        <span>租期剩余 {{ d.telemetry.hold_remaining_s }} 秒</span>
        <span>健康 {{ d.telemetry.faults.join(', ') || '无已报故障' }}</span>
        <span>可信时间 {{ d.telemetry.time_valid ? '是' : '否' }} / epoch {{ d.telemetry.control_epoch }}</span>
      </div>
      <fieldset :disabled="!d.can_control || !socketReady() || stale(d) || waiting(d.device_id)">
        <legend>控制请求（本地关闭优先，由终端校验执行）</legend>
        <button type="button" @click="request(d, 1)">开启风扇</button>
        <button type="button" @click="request(d, 0)">关闭风扇</button>
        <button type="button" @click="request(d, null)">恢复自动模式</button>
        <p>手动控制持续 120 秒，期间按当前灯环输出设置灯环。</p>
      </fieldset>
      <p v-if="waiting(d.device_id)">PENDING · 待终端确认，尚不能认定执行成功</p>
      <p v-if="d.telemetry && d.telemetry.mode === 'LOCAL_OFF'">终端本地关闭锁定，请在设备上短按解除。</p>
    </article>
    <h2>命令记录</h2><p>TIMEOUT = 10秒未收到 ACK，结果未知。已确认表示输出逻辑写入，不证明风扇机械转动。</p>
    <div class="history"><table><thead><tr><th>命令 ID / 设备</th><th>请求</th><th>结果</th></tr></thead>
      <tbody><tr v-for="r in msg.payload.commands.slice(0, 20)" :key="r.command.cmd_id">
        <td>{{ r.command.cmd_id }}<br>{{ r.command.device_id }}</td>
        <td>{{ r.command.mode }} / 风扇 {{ r.command.fan_out }} / LED {{ r.command.led_out }}</td>
        <td>{{ label(effectiveState(r)) }} {{ r.reason || '' }} {{ r.late ? '（迟到 ACK）' : '' }}</td>
      </tr></tbody></table></div>
  </section>
</template>
<script>
export default {
  data() { return { submitting: {}, tick: performance.now(), received: performance.now(), timer: null } },
  watch: { msg() { this.received = performance.now() } },
  mounted() { this.timer = setInterval(() => { this.tick = performance.now() }, 500) },
  unmounted() { clearInterval(this.timer) },
  methods: {
    socketReady() { return this.$socket && this.$socket.connected },
    effectiveState(r) { return r.state === 'PENDING' && Math.max(0, this.tick - this.received) >= r.ack_remaining_ms ? 'TIMEOUT' : r.state },
    stale(d) { return d.age_ms === null || d.age_ms + Math.max(0, this.tick - this.received) >= 15000 },
    label(s) { return ({PENDING:'PENDING · 待确认', APPLIED:'APPLIED · 已确认', REJECTED:'REJECTED · 终端拒绝', TIMEOUT:'TIMEOUT · 结果未知'})[s] || s },
    waiting(id) { return this.tick - (this.submitting[id] ?? -10000) < 1500 || this.msg.payload.commands.some(r => r.command.device_id === id && this.effectiveState(r) === 'PENDING') },
    request(device, fan) {
      const id = device.device_id
      if (!this.socketReady() || !device.can_control || this.stale(device) || this.waiting(id)) return

      // The contract requires an absolute setting for both outputs in REMOTE.
      const intent = fan === null
        ? { mode: 'AUTO' }
        : { mode: 'REMOTE', fan_out: fan, led_out: device.telemetry.led_out }
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
.eco fieldset:disabled { opacity:.45 }
.eco .history { overflow:auto } .eco table { width:100%; border-collapse:collapse } .eco td,.eco th { border-bottom:1px solid #bbcfc5; padding:10px; text-align:left; overflow-wrap:anywhere }
</style>
