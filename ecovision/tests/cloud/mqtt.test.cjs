const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {createRequire}=require('node:module');
const dep=createRequire(path.resolve(__dirname,'../../cloud/package.json'));
const mqtt=dep('mqtt');
const {testBroker}=require('../../cloud/src/test-broker.cjs');
const {Bridge}=require('../../cloud/src/bridge.cjs');
const {simulator}=require('../../cloud/src/sim-device.cjs');
const {startServer}=require('../../cloud/src/server.cjs');
const {randomBytes}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=8000) {const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await delay(25);}assert.fail('condition timed out');}
test('TLS MQTT telemetry, independent identity ACL, Node-RED HTTP/socket authentication, PENDING and real ACK', {timeout:30000}, async t=>{
  const cleanups=[];t.after(async()=>{for(const close of cleanups.reverse())await close();});
  const runtimeRoot=path.resolve(__dirname,'../../cloud/.runtime');
  fs.mkdirSync(runtimeRoot,{recursive:true});
  const dir=fs.mkdtempSync(path.join(runtimeRoot,'test-'));
  const cert=await dep('selfsigned').generate([{name:'commonName',value:'localhost'}],{keySize:2048,extensions:[{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]});
  const ca=path.join(dir,'ca.pem');fs.writeFileSync(ca,cert.cert);
  const secret=()=>randomBytes(24).toString('hex');
  const cloudPassword=secret(),devicePassword=secret(),samplePassword=secret();
  const historicalTopic='ecovision/sim002/cmd';
  const historicalMarker=Buffer.from('migration-fixture-not-a-command');
  const broker=await testBroker({key:cert.private,cert:cert.cert,retained:[{
    cmd:'publish',topic:historicalTopic,payload:historicalMarker,qos:1,retain:true
  }],identities:{
    cloud:{role:'cloud',devices:['sim001','sim002'],password:cloudPassword},
    sim001:{role:'device',devices:['sim001'],password:devicePassword},
    sim002:{role:'device',devices:['sim002'],password:samplePassword}}});
  cleanups.push(()=>broker.close());
  const config={port:0,runtime:path.join(dir,'runtime'),viewer_user:'operator',viewer_password:secret(),public_origin:'https://eco.example.invalid',
    monitor:{device_id:'sim001',token:secret()},mqtt:{url:`mqtts://localhost:${broker.port}`,ca,username:'cloud',password:cloudPassword,devices:['sim001','sim002'],simulated:['sim001','sim002']}};
  const app=await startServer(config);cleanups.push(()=>app.stop());
  const device=simulator({url:config.mqtt.url,ca,device_id:'sim001',username:'sim001',password:devicePassword,ack_delay_ms:1500});cleanups.push(()=>device.close());
  await until(()=>app.bridge.cloud.view().devices[0].can_control);
  assert.equal(app.bridge.cloud.view().devices[0].simulated,true);
  const observed=app.bridge.cloud.view().devices[0].telemetry;
  const cmd=app.bridge.command('sim001',{mode:'REMOTE',fan_out:1,fan_level:5,led_out:1},observed);
  assert.equal(app.bridge.cloud.view().commands[0].state,'PENDING');
  await until(()=>app.bridge.cloud.view().commands[0].state==='APPLIED');
  assert.equal(app.bridge.cloud.view().commands[0].acks[0].payload.cmd_id,cmd.cmd_id);
  await until(()=>app.bridge.cloud.view().devices[0].telemetry.mode==='REMOTE');
  const url=`http://127.0.0.1:${app.port}`;
  assert.equal((await fetch(url+'/api/state')).status,401);
  assert.equal((await fetch(url+'/dashboard/devices')).status,401);
  const headers={Authorization:'Basic '+Buffer.from(config.viewer_user+':'+config.viewer_password).toString('base64')};
  assert.equal((await fetch(url+'/dashboard/devices',{headers})).status,200);
  assert.equal((await fetch(url+'/flows',{headers})).status,404);
  const state=await (await fetch(url+'/api/state',{headers})).json();
  assert.equal(state.commands[0].state,'APPLIED');
  const latest = url+'/api/monitor/sim001/latest';
  const monitorHeaders = { Authorization: 'Bearer '+config.monitor.token };
  const sampleConfigPath = path.join(dir,'sample.local.json');
  fs.writeFileSync(sampleConfigPath,JSON.stringify({simulated:true,device_id:'sim002',url:config.mqtt.url,ca,username:'sim002',password:samplePassword}),{mode:0o600});
  const script = path.resolve(__dirname,'../../cloud/scripts/publish-sample.cjs');
  const {stdout} = await promisify(execFile)(process.execPath,[script,sampleConfigPath],{timeout:12000});
  assert.match(stdout,/SIMULATED ecovision\/sim002\/telemetry/);
  await until(()=>app.bridge.cloud.view().devices[1].telemetry?.count===2);
  assert.equal((await fetch(latest)).status,401);
  assert.equal((await fetch(latest,{headers})).status,401);
  assert.equal((await fetch(url+'/api/monitor/sim002/latest',{headers:monitorHeaders})).status,404);
  assert.equal((await fetch(latest,{method:'POST',headers:monitorHeaders})).status,405);
  assert.equal((await fetch(url+'/api/state',{headers:monitorHeaders})).status,401);
  assert.equal((await fetch(url+'/dashboard/devices',{headers:monitorHeaders})).status,401);
  const monitorResponse = await fetch(latest,{headers:monitorHeaders});
  assert.equal(monitorResponse.status,200);
  assert.equal(monitorResponse.headers.get('cache-control'),'no-store');
  const snapshot = await monitorResponse.json();
  assert.equal(snapshot.simulated,true);
  assert.equal(snapshot.connection,'ONLINE');
  assert.equal(snapshot.telemetry.count,2);
  assert.equal(snapshot.telemetry.temp_c,28.5);
  assert.equal(snapshot.telemetry.humidity_pct,45);
  assert.equal(snapshot.telemetry.fan_out,1);
  assert.equal(snapshot.telemetry.fan_level,5);
  assert.equal(snapshot.telemetry.led_out,1);
  assert.equal(snapshot.telemetry.mode,'REMOTE');
  assert.equal(snapshot.can_control,undefined);
  assert.equal(snapshot.commands,undefined);
  const {io}=dep('socket.io-client');
  const denied=io(url,{path:'/dashboard/socket.io',transports:['websocket'],reconnection:false});
  cleanups.push(()=>denied.close());
  await new Promise((resolve,reject)=>{denied.once('connect',()=>reject(Error('unauthenticated socket connected')));denied.once('connect_error',resolve);});
  const foreignSocket=io(url,{path:'/dashboard/socket.io',transports:['websocket'],extraHeaders:{...headers,Origin:'https://other.example.invalid'},reconnection:false});
  cleanups.push(()=>foreignSocket.close());
  await new Promise((resolve,reject)=>{foreignSocket.once('connect',()=>reject(Error('foreign origin socket connected')));foreignSocket.once('connect_error',resolve);});
  const socket=io(url,{path:'/dashboard/socket.io',transports:['websocket'],extraHeaders:{...headers,Origin:config.public_origin},reconnection:false});
  cleanups.push(()=>socket.close());
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
  // Exercise the same authenticated widget event used by the browser to switch the fan off.
  socket.emit('widget-send','eco-widget',{payload:{device_id:'sim001',observed:{boot_id:observed.boot_id,control_epoch:observed.control_epoch},intent:{mode:'REMOTE',fan_out:0,fan_level:0,led_out:0}}});
  await until(()=>app.bridge.cloud.view().commands[0].command.cmd_id!==cmd.cmd_id);
  const off=app.bridge.cloud.view().commands[0];
  assert.equal(off.state,'PENDING');
  assert.equal(off.command.fan_out,0);
  await until(()=>app.bridge.cloud.view().commands[0].state==='APPLIED');
  await until(()=>app.bridge.cloud.view().devices[0].telemetry.fan_out===0);
  const offAck=app.bridge.cloud.view().commands[0].acks[0].payload;
  assert.equal(offAck.cmd_id,off.command.cmd_id);
  assert.equal(offAck.fan_level,0);
  assert.equal(offAck.led_out,0);

  // An isolated AC-capable simulator exercises the same dashboard event and broker topics.
  const acDevice=await mqtt.connectAsync(config.mqtt.url,{ca:cert.cert,username:'sim002',password:samplePassword,
    reconnectPeriod:0,protocolVersion:4,clean:true});
  cleanups.push(()=>acDevice.endAsync(true));
  const [grant]=await acDevice.subscribeAsync('ecovision/sim002/cmd',{qos:1});
  assert.equal(grant.qos,1);
  const acTelemetry={...observed,device_id:'sim002',boot_id:'acdef123',seq:1,control_epoch:0,
    ts:Math.floor(Date.now()/1000),mode:'AUTO',hold_remaining_s:0,v:'1.2.0'};
  await acDevice.publishAsync('ecovision/sim002/telemetry',JSON.stringify(acTelemetry),{qos:1});
  await until(()=>app.bridge.cloud.view().devices[1].ac_control_available);
  let remoteAc;
  acDevice.on('message',(topic,bytes,packet)=>{
    if (!packet.retain) remoteAc=JSON.parse(bytes);
  });
  for (const temperature of [23,0]) {
    socket.emit('widget-send','eco-widget',{payload:{device_id:'sim002',
      observed:{boot_id:acTelemetry.boot_id,control_epoch:0},intent:{ac_temp_c:temperature}}});
    await until(()=>remoteAc?.ac_temp_c===temperature);
    assert.equal(remoteAc.fan_out,undefined);
    const ack={v:remoteAc.v,device_id:'sim002',cmd_id:remoteAc.cmd_id,boot_id:remoteAc.boot_id,
      control_epoch:0,status:'AC_ACCEPTED',reason:'OK',received_at:acTelemetry.ts,uptime_ms:1,ac_temp_c:temperature};
    await acDevice.publishAsync('ecovision/sim002/ack',JSON.stringify(ack),{qos:1});
    await until(()=>app.bridge.cloud.view().commands[0].state==='AC_ACCEPTED');
    assert.equal(app.bridge.cloud.view().commands[0].command.ac_temp_c,temperature);
  }

  const other=mqtt.connect(config.mqtt.url,{ca:cert.cert,username:'sim001',password:devicePassword,reconnectPeriod:0,protocolVersion:4,clean:true});other.on('error',()=>{});cleanups.push(()=>other.endAsync(true));
  await new Promise(resolve=>other.once('connect',resolve));
  const granted=await other.subscribeAsync('ecovision/ev002/cmd',{qos:1}).catch(()=>[]);
  assert.ok(!granted.length || granted[0].qos===128);
  const closed=new Promise(resolve=>other.once('close',resolve));
  other.publish('ecovision/ev002/telemetry','{}',{qos:1});await closed;
  const retained=mqtt.connect(config.mqtt.url,{ca:cert.cert,username:'cloud',password:cloudPassword,reconnectPeriod:0});
  retained.on('error',()=>{});
  cleanups.push(()=>retained.endAsync(true));
  await new Promise(resolve=>retained.once('connect',resolve));
  const refusedRetained=new Promise(resolve=>retained.once('close',resolve));
  retained.publish('ecovision/sim001/cmd','{}',{qos:1,retain:true});
  await refusedRetained;

  // Existing stored messages survive ACL changes. Delete the exact entry before reconnecting.
  async function subscribeForRetained() {
    const sub=await mqtt.connectAsync(config.mqtt.url,{ca:cert.cert,username:'sim002',password:samplePassword,
      clientId:'migration-fixture',protocolVersion:4,clean:true,reconnectPeriod:0});
    cleanups.push(()=>sub.endAsync(true));
    const messages=[];
    sub.on('message',(topic,payload,packet)=>{
      if (topic===historicalTopic && packet.retain) messages.push(payload);
    });
    const [grant]=await sub.subscribeAsync(historicalTopic,{qos:1});
    assert.equal(grant.qos,1);
    return {sub,messages};
  }
  const first=await subscribeForRetained();
  await until(()=>first.messages.length===1);
  assert.deepEqual(first.messages,[historicalMarker]);
  await first.sub.endAsync(true);
  await broker.clearRetained(historicalTopic);
  const afterCleanup=await subscribeForRetained();
  await delay(150);
  assert.deepEqual(afterCleanup.messages,[]);

  const wrong=mqtt.connect(config.mqtt.url,{ca:cert.cert,username:'sim001',password:secret(),reconnectPeriod:0});wrong.on('error',()=>{});cleanups.push(()=>wrong.endAsync(true));
  await new Promise((resolve,reject)=>{wrong.once('connect',()=>reject(Error('bad password accepted')));wrong.once('error',resolve);});
  // Verify server certificate validation remains enabled.
  const untrusted=mqtt.connect(config.mqtt.url,{username:'sim001',password:devicePassword,reconnectPeriod:0});untrusted.on('error',()=>{});cleanups.push(()=>untrusted.endAsync(true));
  await new Promise((resolve,reject)=>{untrusted.once('connect',()=>reject(Error('untrusted TLS accepted')));untrusted.once('error',resolve);});
  const logs=fs.readdirSync(path.join(dir,'runtime/events')).map(f=>fs.readFileSync(path.join(dir,'runtime/events',f),'utf8')).join('');
  assert.match(logs,/"type":"command"/);assert.match(logs,/"type":"ack"/);assert.ok(!logs.includes(cloudPassword));assert.ok(!logs.includes(config.monitor.token));
});
