// Pure virtual-time controller. This is never hardware evidence.
export class Simulation {
  constructor(policy) {
    if (policy.version !== '1.0.0') throw Error('不支持的控制规格');
    this.policy=policy; this.t=0; this.seq=0;
    this.input={count:0,temp:26,vision:true,network:true}; this.events=[];
    this.occupancy='UNKNOWN'; this.fan=0; this.led=0;
    this.lastVision=null; this.lastTemp=null; this.sampleCount=null; this.sampleTemp=null; this.positive=0;
    this.zeroSince=null; this.dwellSince=null; this.dwellTarget=null; this.faultSince=null;
  }
  inject(patch) {
    for (const [key,value] of Object.entries(patch)) {
      if (!Object.hasOwn(this.input,key) ||
          (key==='count' && (!Number.isInteger(value)||value<0||value>20)) ||
          (key==='temp' && (!Number.isFinite(value)||value< -40||value>85)) ||
          (['vision','network'].includes(key) && typeof value!=='boolean')) throw Error('无效场景输入');
    }
    Object.assign(this.input,patch);
    this.events.push({at_s:this.t,input:{...patch}});
  }
  advance(seconds=1) {
    if (!Number.isInteger(seconds)||seconds<0||seconds>3600) throw Error('时间步进须为0—3600秒');
    for(let n=0;n<seconds;n++) { this.t++; this.tick(); }
  }
  tick() {
    const c=this.policy.control;
    this.lastTemp=this.t; this.sampleTemp=this.input.temp;
    if (this.input.vision) {
      this.lastVision=this.t; this.sampleCount=this.input.count;
      if(this.input.count>0) {
        this.zeroSince=null;
        if(++this.positive>=c.entry_frames) this.occupancy='OCCUPIED';
      } else {
        this.positive=0;
        this.zeroSince ??= this.t;
        if(this.t-this.zeroSince>=c.vacant_s) this.occupancy='VACANT';
      }
    } else {
      // A missing frame interrupts continuous confirmation even before stale.
      this.positive=0; this.zeroSince=null;
    }
    const valid=this.lastVision!==null&&(this.t-this.lastVision)*1000<this.policy.uart.vision_stale_ms;
    if(!valid) { this.occupancy='UNKNOWN'; this.faultSince ??= this.t; }
    else this.faultSince=null;
    if(this.faultSince!==null && this.t-this.faultSince>=c.fault_off_s) {
      this.fan=0; this.led=0; this.dwellSince=null; this.dwellTarget=null;
    } else if(valid && this.occupancy==='VACANT') {
      this.fan=0; this.led=0; this.dwellSince=null; this.dwellTarget=null;
    } else if(valid && this.occupancy==='OCCUPIED') {
      this.led=1;
      const target=this.input.temp>=c.fan_on_c ? 1 : this.input.temp<=c.fan_off_c ? 0 : null;
      if(target===null || target===this.fan) { this.dwellSince=null; this.dwellTarget=null; }
      else {
        if(this.dwellTarget!==target) { this.dwellTarget=target; this.dwellSince=this.t; }
        if(this.t-this.dwellSince>=c.temperature_dwell_s) { this.fan=target; this.dwellSince=null; this.dwellTarget=null; }
      }
    } else { this.dwellSince=null; this.dwellTarget=null; }
    this.seq=(this.seq+1)>>>0;
  }
  snapshot() {
    const age=this.lastVision===null?null:(this.t-this.lastVision)*1000;
    const valid=age!==null&&age<this.policy.uart.vision_stale_ms;
    return {v:this.policy.version,device_id:'sandbox',boot_id:'0000000000000001',seq:this.seq,
      uptime_ms:this.t*1000,ts:null,time_valid:false,control_epoch:0,
      count:valid?this.sampleCount:null,vision_valid:valid,vision_age_ms:age,
      temp_c:this.sampleTemp,temp_valid:this.lastTemp!==null,
      temp_age_ms:this.lastTemp===null?null:0,humidity_pct:null,humidity_valid:false,
      occupancy:this.occupancy,mode:'AUTO',fan_out:this.fan,led_out:this.led,hold_remaining_s:0,
      net_state:this.input.network?'ONLINE':'OFFLINE',last_cmd_id:null,
      faults:[...(!valid?['VISION_FAULT']:[]),...(this.lastTemp===null?['SENSOR_FAULT']:[]),...(!this.input.network?['NET_OFFLINE']:[])]};
  }
  scenario() { return {version:this.policy.version,source:'SIMULATION',duration_s:this.t,events:structuredClone(this.events)}; }
  static replay(policy,data) {
    if(data?.version!==policy.version||data.source!=='SIMULATION'||!Number.isInteger(data.duration_s)||data.duration_s<0||data.duration_s>3600||!Array.isArray(data.events)||data.events.length>10000) throw Error('无效场景文件');
    const s=new Simulation(policy);
    for(const e of data.events) {
      if(!Number.isInteger(e.at_s)||e.at_s<s.t||e.at_s>data.duration_s||!e.input||typeof e.input!=='object'||Array.isArray(e.input)) throw Error('无效场景事件');
      s.advance(e.at_s-s.t); s.inject(e.input);
    }
    s.advance(data.duration_s-s.t); return s;
  }
}

// Deliberately disconnected until the cloud team supplies the authorized API.
// No MQTT client, device credentials, synthetic telemetry or optimistic output.
export class RealAdapter {
  snapshot() { return null; }
  async sendControl() { throw Error('云端授权接口尚未对接，禁止发送实物控制'); }
}
