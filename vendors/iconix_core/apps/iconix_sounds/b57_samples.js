/* Audi A6 3.0 BiTDI user-supplied recording. Estimated RPM anchors; no measured RPM or true idle. */
'use strict';
var fs = require('fs');
var path = require('path');
function clamp(v,a,b) { return v < a ? a : (v > b ? b : v); }
function readWav(filename) {
  var b = fs.readFileSync(filename);
  if (b.toString('ascii',0,4) !== 'RIFF' || b.toString('ascii',8,12) !== 'WAVE') throw new Error('not WAV: '+filename);
  var at=12, rate=0, channels=0, bits=0, format=0, start=-1, bytes=0;
  while (at+8 <= b.length) {
    var type=b.toString('ascii',at,at+4), len=b.readUInt32LE(at+4), begin=at+8;
    if (begin+len>b.length) throw new Error('invalid WAV chunk');
    if (type==='fmt ') { format=b.readUInt16LE(begin);channels=b.readUInt16LE(begin+2);rate=b.readUInt32LE(begin+4);bits=b.readUInt16LE(begin+14); }
    if (type==='data') {start=begin;bytes=len;break;}
    at=begin+len+(len&1);
  }
  if (format!==1 || channels!==1 || bits!==16 || !rate || start<0 || bytes<200) throw new Error('BiTDI requires mono 16-bit PCM WAV');
  var n=bytes/2|0, v=new Float32Array(n);
  for(var i=0;i<n;i++) v[i]=b.readInt16LE(start+i*2)/32768;
  return {buf:v, rate:rate, n:n};
}
function lerp(buf, pos) {
  if (pos<=0) return buf[0];
  var j=pos|0; if (j>=buf.length-1) return buf[buf.length-1];
  var a=pos-j; return buf[j]*(1-a)+buf[j+1]*a;
}

function Loop(track, outputRate, referenceRpm) {
  this.track=track; this.ratio=track.rate/outputRate; this.ref=referenceRpm; this.pos=0;
}
Loop.prototype.next=function(rpm) {
  var b=this.track.buf, n=b.length, j=Math.floor(this.pos), f=this.pos-j;
  var v=b[j]*(1-f)+b[(j+1)%n]*f;
  this.pos=(this.pos+this.ratio*clamp(rpm/this.ref,.23,1.85))%n;
  return v;
};
function B57Samples(outRate,dir) {
  this.rate=outRate||44100; this.dir=dir||__dirname; this.ok=false; this.error=null;
  this.mixLoad=0; this.mixHigh=0; this.mixIdle=1;
  try {
    this.idle=new Loop(readWav(path.join(this.dir,'b57_idle.wav')),this.rate,2520);
    this.accel=new Loop(readWav(path.join(this.dir,'b57_accel.wav')),this.rate,2570);
    this.high=new Loop(readWav(path.join(this.dir,'b57_high.wav')),this.rate,3100);
    this.decel=new Loop(readWav(path.join(this.dir,'b57_decel.wav')),this.rate,2920);
    this.ok=true;
  } catch(e) { this.error='BiTDI WAV nicht verfuegbar: '+e.message; }
}
B57Samples.prototype.render=function(out,off,n,amp,ampStep,rpm,load,overrun,intensity) {
  var peak=0,o=off*2,i,v,a;
  if(!this.ok) { for(i=0;i<n;i++){out[o++]=0;out[o++]=0;} return {peak:0,amp:amp+ampStep*n}; }
  var r=clamp(rpm,700,4550), idle=clamp((1550-r)/650,0,1);
  var high=clamp((r-2650)/850,0,1), power=overrun?0:clamp((load-.025)/.65,0,1);
  var k=1-Math.exp(-1/(this.rate*.015));
  var mi=this.mixIdle,mh=this.mixHigh,ml=this.mixLoad;
  for(i=0;i<n;i++) {
    mi+=(idle-mi)*k; mh+=(high-mh)*k; ml+=(power-ml)*k;
    var low=this.idle.next(r), mid=this.accel.next(r), hi=this.high.next(r), coast=this.decel.next(r);
    var drive=mid*(1-mh)+hi*mh;
    var running=coast*(1-ml)+drive*ml;
    v=(low*mi+running*(1-mi))*(.55+.48*ml*intensity); // keep steady low-load presence
    amp+=ampStep; v*=amp*1.3; v=v/(1+Math.abs(v)*.17); v=clamp(v,-.95,.95);
    out[o++]=v;out[o++]=v; a=Math.abs(v); if(a>peak)peak=a;
  }
  this.mixIdle=mi;this.mixHigh=mh;this.mixLoad=ml;
  return {peak:peak,amp:amp};
};
module.exports=B57Samples;
