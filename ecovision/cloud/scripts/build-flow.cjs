const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
// Keep the embedded Vue template identical across Windows and Linux checkouts.
const dashboardTemplate = fs.readFileSync(path.join(root, 'dashboard.vue'), 'utf8').replace(/\r\n/g, '\n');
const flows = [
  { id:'eco-tab', type:'tab', label:'EcoVision · server-owned state', disabled:false, info:'MQTT credentials stay in server config. Dashboard commands remain PENDING until terminal ACK.' },
  { id:'eco-tick', type:'inject', z:'eco-tab', name:'Refresh freshness / ACK timeout', props:[], repeat:'1', once:true, onceDelay:0.5, x:180,y:100,wires:[['eco-state']] },
  { id:'eco-state', type:'function', z:'eco-tab', name:'Read cloud state', func:'return {payload:global.get("eco").view()};', outputs:1,x:440,y:100,wires:[['eco-widget']] },
  { id:'eco-widget', type:'ui-template', z:'eco-tab', group:'eco-group', page:'', ui:'', name:'Telemetry and ACK dashboard', order:1,width:12,height:0, head:'', format:dashboardTemplate, storeOutMessages:false,passthru:false,resendOnRefresh:true,templateScope:'local',className:'',x:700,y:100,wires:[['eco-command']] },
  { id:'eco-command', type:'function', z:'eco-tab', name:'Validate intent / publish / PENDING', func:'const eco=global.get("eco");\ntry { eco.submit(msg.payload); return {payload:eco.view()}; } catch(e) { return {payload:{...eco.view(),error:e.message}}; }', outputs:1,x:700,y:200,wires:[['eco-widget']] },
  { id:'eco-base', type:'ui-base', name:'EcoVision', path:'/dashboard', appIcon:'', includeClientData:true, acceptsClientConfig:[], showPathInSidebar:false, showPageTitle:true, navigationStyle:'default', titleBarStyle:'default' },
  { id:'eco-page', type:'ui-page', name:'设备与命令', ui:'eco-base', path:'/devices', icon:'home', layout:'grid', theme:'eco-theme', order:1, className:'', visible:'true', disabled:'false' },
  { id:'eco-group', type:'ui-group', name:'EcoVision', page:'eco-page', width:12,height:1,order:1,showTitle:false,visible:'true',disabled:'false',groupType:'default' },
  { id:'eco-theme', type:'ui-theme', name:'EcoVision green', colors:{surface:'#ffffff',primary:'#17684f',bgPage:'#edf4ef',groupBg:'#ffffff',groupOutline:'#b7cdbf'}, sizes:{density:'default',pagePadding:'12px',groupGap:'12px',groupBorderRadius:'8px',widgetGap:'12px'} }
];
fs.writeFileSync(path.join(root,'flows.json'), JSON.stringify(flows,null,2)+'\n');
