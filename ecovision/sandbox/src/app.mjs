import {Simulation,RealAdapter} from './model.mjs';
const $=id=>document.getElementById(id);
let sim,real=new RealAdapter(),timer=null,source='sim',policy;
function stop(){clearInterval(timer);timer=null;$('play').textContent='开始运行';}
function guard(action){try{action();$('error').textContent='';}catch(e){$('error').textContent=e.message;}}
function syncInputs(){const i=sim.input;$('count').value=i.count;$('temp').value=i.temp;$('vision').checked=i.vision;$('net').checked=i.network;inputLabels();}
function inputLabels(){$('countInput').textContent=`${$('count').value} 人`;$('tempInput').textContent=`${Number($('temp').value).toFixed(1)} ℃`;}
function render(){
  const s=source==='sim'?sim.snapshot():real.snapshot();
  $('source').textContent=source==='sim'?'模拟模式 · 非硬件反馈':'实物模式 · 未接入云端';
  $('source').classList.toggle('real',source==='real');
  $('clock').textContent=source==='sim'?`虚拟时间 ${sim.t} s`:'等待真实遥测';
  $('network').textContent=source==='sim'?`模拟网络${sim.input.network?'在线':'掉线 · 仅本地快照'}`:'连接状态未知';
  $('mode').textContent=s?`${s.mode} / 自动`:'运行模式未知';
  $('countValue').textContent=s?.count??'—';$('tempValue').textContent=s?.temp_c===null||!s?'—':`${s.temp_c.toFixed(1)}℃`;
  for(const k of ['fan','led']){$(`${k}Value`).textContent=s?`${s[`${k}_out`]} / ${s[`${k}_out`]?'开':'关'}`:'未知';}
  $('fan').classList.toggle('on',s?.fan_out===1);$('lamp').classList.toggle('on',s?.led_out===1);
  $('people').replaceChildren();
  for(let n=0;n<Math.min(5,s?.count??0);n++){const p=document.createElement('div');p.className='person';p.textContent='♟';const label=document.createElement('small');label.textContent=`人员 ${n+1}`;p.append(label);$('people').append(p);}
  $('state').textContent=s?`占用状态：${{UNKNOWN:'未知 / 确认中',OCCUPIED:'确认有人',VACANT:'确认无人'}[s.occupancy]} · ${s.faults.join(' / ')||'无故障'}`:'未接入云端授权接口。人数、温度及设备状态均未知；控制已禁用。';
  $('json').textContent=s?JSON.stringify(s,null,2):'无真实遥测；不会使用模拟数据填充。';
  $('injection').disabled=source!=='sim';$('scenarios').disabled=source!=='sim';
}
try{
  const response=await fetch('../contracts/policy.json');if(!response.ok)throw Error('无法读取公共控制规格');policy=await response.json();sim=new Simulation(policy);
  for(const id of ['count','temp','vision','net']){$(id).addEventListener('input',()=>guard(()=>{sim.inject({count:Number($('count').value),temp:Number($('temp').value),vision:$('vision').checked,network:$('net').checked});inputLabels();render();}));}
  $('play').onclick=()=>{if(timer)stop();else{timer=setInterval(()=>guard(()=>{sim.advance();render();}),1000);$('play').textContent='暂停';}};
  $('step').onclick=()=>guard(()=>{sim.advance();render();});$('skip').onclick=()=>guard(()=>{sim.advance(30);render();});
  $('reset').onclick=()=>{stop();sim=new Simulation(policy);syncInputs();render();};
  $('sourceMode').onchange=()=>{stop();source=$('sourceMode').value;render();};
  $('save').onclick=()=>guard(()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(sim.scenario(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='ecovision-simulation.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  $('import').onchange=async()=>{try{const file=$('import').files[0];if(!file)return;if(file.size>1000000)throw Error('场景文件过大');const next=Simulation.replay(policy,JSON.parse(await file.text()));stop();sim=next;syncInputs();render();$('error').textContent='';}catch(e){$('error').textContent=e.message;}finally{$('import').value='';}};
  $('loadPreset').onclick=async()=>{try{const r=await fetch('scenarios.json');if(!r.ok)throw Error('场景加载失败');const data=await r.json();const next=Simulation.replay(policy,data[$('preset').value]);stop();sim=next;syncInputs();render();$('error').textContent='';}catch(e){$('error').textContent=e.message;}};
  render();
}catch(e){$('error').textContent=`启动失败：${e.message}。请从项目根目录启动HTTP服务，访问 /sandbox/。`;$('injection').disabled=true;$('scenarios').disabled=true;}
