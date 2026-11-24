import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as model from '../../sandbox/src/model.mjs';
const policy = JSON.parse(readFileSync(new URL('../../contracts/policy.json', import.meta.url)));
const create = () => new model.Simulation(policy);

test('simulation exposes its controller', () => assert.equal(typeof model.Simulation, 'function'));
test('three fresh frames confirm entry; temperature dwell and hysteresis apply', () => {
  const s = create(); s.inject({count:2,temp:29});
  s.advance(2); assert.equal(s.snapshot().led_out,0);
  s.advance(1); assert.equal(s.snapshot().led_out,1);
  s.advance(4); assert.equal(s.snapshot().fan_out,0);
  s.advance(1); assert.equal(s.snapshot().fan_out,1);
  s.inject({temp:27.5}); s.advance(6); assert.equal(s.snapshot().fan_out,1);
  s.inject({temp:27}); s.advance(5); assert.equal(s.snapshot().fan_out,1);
  s.advance(1); assert.equal(s.snapshot().fan_out,0);
});
test('vacancy requires continuous thirty seconds and invalid vision is UNKNOWN', () => {
  const s=create(); s.inject({count:1}); s.advance(3);
  s.inject({count:0}); s.advance(30); assert.equal(s.snapshot().led_out,1);
  s.advance(1); assert.equal(s.snapshot().led_out,0);
  s.inject({vision:false}); s.advance(5);
  assert.equal(s.snapshot().occupancy,'UNKNOWN'); assert.equal(s.snapshot().count,null);
});
test('vision timeout holds output then shuts both after sixty seconds of fault', () => {
  const s=create(); s.inject({count:2,temp:29}); s.advance(8);
  s.inject({vision:false}); s.advance(5);
  assert.equal(s.snapshot().vision_valid,false); assert.equal(s.snapshot().led_out,1);
  s.advance(59); assert.equal(s.snapshot().led_out,1);
  s.advance(1); assert.equal(s.snapshot().fan_out,0); assert.equal(s.snapshot().led_out,0);
});
test('offline snapshot is explicit while local control continues', () => {
  const s=create(); s.inject({network:false,count:2,temp:29}); s.advance(8);
  assert.equal(s.snapshot().fan_out,1); assert.equal(s.snapshot().net_state,'OFFLINE');
  assert.ok(s.snapshot().faults.includes('NET_OFFLINE'));
});
test('saved event timeline replays exactly and rejects malformed input', () => {
  const s=create(); s.inject({count:3,temp:30}); s.advance(12);
  s.inject({network:false,vision:false}); s.advance(7);
  const restored=model.Simulation.replay(policy,s.scenario());
  assert.deepEqual(restored.snapshot(),s.snapshot());
  assert.throws(()=>s.inject({count:2.5}));
  assert.throws(()=>model.Simulation.replay(policy,{version:'wrong'}));
});
test('real adapter starts unknown, never falls back to simulation, rejects commands without API',async()=>{
  const real=new model.RealAdapter(); assert.equal(real.snapshot(),null);
  await assert.rejects(()=>real.sendControl({fan_out:1}),/授权接口/);
  assert.equal(real.snapshot(),null);
});
test('input injection cannot rewrite the last sampled telemetry',()=>{
  const s=create();s.inject({count:2,temp:29});s.advance(8);
  s.inject({count:0,temp:20,vision:false});
  assert.equal(s.snapshot().count,2);assert.equal(s.snapshot().temp_c,29);
  s.advance(1);assert.equal(s.snapshot().count,2);assert.equal(s.snapshot().temp_c,20);
});
