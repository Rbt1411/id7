'use strict';
const assert = require('assert');
const fs = require('fs');
process.env.ICONIX_ALSA_FORCE = '1';
process.env.ICONIX_PYTHON = '/usr/bin/python3';
const engine = require('../tools/iconix-audiod/engine');
const route = require('../apps/iconix_sounds/smartx_route');
async function test() {
  assert.strictEqual(engine.RATE, 48000, 'CarLife SmartX should run at 48 kHz');
  const b = engine.candidates({device:'smartx'});
  assert.strictEqual(b.length, 1, 'SmartX should have no fallback to occupied default card');
  assert(b[0].argv.join(' ').includes('plug:smartx:CarLifeMedia_CF_48_STEREO'));
  const e = new engine.Engine({log:function(){}});
  e.setDevice('smartx');
  assert.strictEqual(e.routeActive(), false, 'SmartX fails closed on startup');
  e.routeLease(true);
  assert.strictEqual(e.routeActive(), true);
  e.routeLease(false);
  assert.strictEqual(e.routeActive(), false);
  let current=[], nextId=10, actions=[];
  const logger={info:function(){},warn:function(){}};
  const signals={
    proxy: async function(iface){return {iface:iface}},
    onAvailable: function(p,cb){cb(true)},
    call: async function(p,action,args){
      actions.push(action);
      if(action==='getListMainConnections') return {mainConnections:current.slice()};
      if(action==='hookSourceAvailablityStatusChange') return {amError:'E_OK'};
      if(action==='connect') { const id=nextId++; current.push({sourceID:args.sourceID, sinkID:args.sinkID, mainConnectionID:id});return {amError:'E_OK',mainConnectionID:id}; }
      if(action==='disconnect') {current=current.filter(c=>c.mainConnectionID!==args.mainConnectionID);return {amError:'E_OK'}; }
      throw Error(action);
    }
  };
  const a=route.createCarAudio(signals,logger,{file:null});
  await a.want(true);assert.strictEqual(a.state().connected,true);
  let connects=actions.filter(a=>a==='connect').length;
  await a.want(true);assert.strictEqual(actions.filter(a=>a==='connect').length,connects,'must not duplicate route');
  await a.want(false);assert.strictEqual(a.state().connected,false);assert.strictEqual(current.length,0);
  const other={sourceID:287,sinkID:1024,mainConnectionID:99};current=[other];
  const c=route.createCarAudio(signals,logger,{file:null});
  await c.want(true);assert.strictEqual(c.state().taken,true);assert.strictEqual(actions.filter(a=>a==='connect').length,connects,'must not take foreign connection');
  await c.want(false);assert.deepStrictEqual(current,[other],'must not disconnect foreign route');
  console.log('SmartX routing, explicit lease, foreign connection safety: PASS');
}
test().catch(e=>{console.error(e);process.exitCode=1;});
