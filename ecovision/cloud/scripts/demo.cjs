const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
async function main() {
  const root = path.resolve(__dirname,'..');
  const dir = path.join(root,'.secrets'); fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const configFile = path.join(dir,'demo.local.json');
  let config;
  if (fs.existsSync(configFile)) config=JSON.parse(fs.readFileSync(configFile));
  else {
    const cert = await require('selfsigned').generate([{name:'commonName',value:'localhost'}],{keySize:2048,days:7,extensions:[{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]});
    fs.writeFileSync(path.join(dir,'demo-cert.pem'),cert.cert,{mode:0o600}); fs.writeFileSync(path.join(dir,'demo-key.pem'),cert.private,{mode:0o600});
    const secret = () => randomBytes(24).toString('base64url');
    config={ viewer_user:'operator', viewer_password:secret(), port:1880,
      mqtt:{url:'mqtts://localhost:8883',ca:path.join(dir,'demo-cert.pem'),username:'cloud-demo',password:secret(),devices:['sim001'],simulated:['sim001']},
      device:{device_id:'sim001',username:'sim001',password:secret()} };
    fs.writeFileSync(configFile,JSON.stringify(config,null,2),{mode:0o600});
  }
  if (!config.monitor) {
    config.monitor = { device_id:'sim001', token:randomBytes(24).toString('base64url') };
    fs.writeFileSync(configFile,JSON.stringify(config,null,2),{mode:0o600});
  }
  const {testBroker}=require('../src/test-broker.cjs');
  const broker=await testBroker({key:fs.readFileSync(path.join(dir,'demo-key.pem')),cert:fs.readFileSync(path.join(dir,'demo-cert.pem')),port:8883,
    identities:{[config.mqtt.username]:{role:'cloud',devices:['sim001'],password:config.mqtt.password},[config.device.username]:{role:'device',devices:['sim001'],password:config.device.password}}});
  const app=await require('../src/server.cjs').startServer(config);
  const device=require('../src/sim-device.cjs').simulator({...config.device,url:config.mqtt.url,ca:config.mqtt.ca});
  console.log('SIMULATED DEVICE sim001 — local software test only');
  console.log('Dashboard: http://127.0.0.1:1880/dashboard/devices');
  console.log(`Login is stored locally in ${configFile} (viewer_user / viewer_password). No credentials printed.`);
  console.log('Mini Program: enter device sim001 and monitor.token from the same local file.');
  process.once('SIGINT',async()=>{await device.close();await app.stop();await broker.close();process.exit(0);});
}
main().catch(e=>{console.error(e.stack);process.exit(1);});
