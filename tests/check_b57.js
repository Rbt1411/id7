// Smoke test for the B57 option and seven original Iconix presets. Run with Node on your PC.
'use strict';
var assert=require('assert'), fs=require('fs'), path=require('path');
var root=path.resolve(__dirname,'..'), Profiles=require('../apps/iconix_sounds/profiles');
var Synth=require('../apps/iconix_sounds/synth');
var tool=require('../tools/iconix-audiod/component.json');
var app=require('../apps/iconix_sounds/app.json');
var ids=['six','v8','subtle','turbo4','v10','edrive','espace','b57_540d'];
assert.deepStrictEqual(Profiles.ids,ids);
assert(app.settings.filter(function(s){return s.key==='profile';})[0].options.some(function(x){return x[0]==='b57_540d';}));
['b57_idle.wav','b57_accel.wav','b57_decel.wav','b57_samples.js'].forEach(function(n){
 assert(fs.existsSync(path.join(root,'tools/iconix-audiod',n)));
 assert(fs.existsSync(path.join(root,'apps/iconix_sounds',n)));
 assert(tool.files.some(function(x){return x.path===n;}));
});
ids.forEach(function(id){
 var s=new Synth(44100);s.configure({profile:id,volume:0.65});
 var o=new Float32Array(2048);var pk=0;
 for(var i=0;i<80;i++){
   s.setParams({rpm:850+i*44,load:0.1+i*0.009,speed:10+i,overrun:false});
   pk=Math.max(pk,s.render(o,1024));
   for(var k=0;k<o.length;k++)assert(isFinite(o[k])&&Math.abs(o[k])<=1);
 }
 assert(s.cfg.profile===id && pk>0.003,'No output: '+id);
 if(id==='b57_540d') assert(s.b57 && s.b57.ok,'B57 WAV loading failed');
 console.log('OK '+id+' peak='+pk.toFixed(4));
});
console.log('PASS: 8 profiles, sample assets, manifest');
