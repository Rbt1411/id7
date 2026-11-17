/*
 * BMW B57 540d Sport – sample-based sound engine for Iconix Sounds.
 * Source: user-provided Aquaphobic BMW B57 GTA V/FiveM mod, engine/exhaust sample mixes.
 * Play local 16-bit mono WAV loops using overlap-add micro-grains and interpolated RPM lookup.
 * No GTA audio is downloaded at runtime; no original procedural profiles are altered.
 * Node 8 compatible. Audio hardware remains the responsibility of Nico's original engine.js.
 */
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
  if (format!==1 || channels!==1 || bits!==16 || !rate || start<0 || bytes<200) throw new Error('B57 requires mono 16-bit PCM WAV');
  var n=bytes/2|0, v=new Float32Array(n);
  for(var i=0;i<n;i++) v[i]=b.readInt16LE(start+i*2)/32768;
  return {buf:v, rate:rate, n:n};
}
function lerp(buf, pos) {
  if (pos<=0) return buf[0];
  var j=pos|0; if (j>=buf.length-1) return buf[buf.length-1];
  var a=pos-j; return buf[j]*(1-a)+buf[j+1]*a;
}
function IdleStream(track,rate) {
  this.track=track;this.step=track.rate/rate;this.pos=0;
  // Wrap inside 90ms overlap region to mask discontinuities in original looping clip.
  this.fade=Math.min(Math.floor(track.rate*.095),Math.floor(track.n*.23));
}
IdleStream.prototype.next=function() {
  var b=this.track.buf, n=this.track.n, pos=this.pos;
  var s=lerp(b,pos);
  if(pos>=n-this.fade) {
    var x=(pos-(n-this.fade))/this.fade;
    s=s*(1-x)+lerp(b,pos-(n-this.fade))*x;
  }
  pos+=this.step;
  if(pos>=n) pos-=(n-this.fade);
  this.pos=pos;
  return s;
};
/*
 * Continuous read heads for the RPM sweeps.
 * The first version reselected 230-ms grains every 115 ms, producing audible
 * "wah-wah" amplitude modulation and a start/stop sensation.  This version
 * reads continuously within a 1.6-s window around the requested RPM, then
 * uses a 180-ms equal-power crossfade at the loop boundary or on large seeks.
 * All state is local; no allocations during the playback callback (Node 8).
 */
function MovingStream(track, outRate, reverse) {
  this.track = track;
  this.step = track.rate / outRate;
  this.reverse = reverse;
  this.window = Math.min(track.n - 2, Math.floor(track.rate * 1.6));
  this.fadeLength = Math.max(128, Math.floor(outRate * .18));
  this.fadeSource = this.fadeLength * this.step;
  this.position = 0;
  this.regionStart = 0;
  this.regionEnd = 0;
  this.initialized = false;
  this.refresh = 0;
  this.fadeIndex = -1;
  this.fadeFrom = 0;
  this.fadeTo = 0;
}
MovingStream.prototype._seek = function (pos) {
  this.fadeFrom = this.position;
  this.fadeTo = clamp(pos, 0, this.track.n - this.fadeSource - 2);
  this.fadeIndex = 0;
};
MovingStream.prototype.next = function (rpm) {
  var t = this.track, n = t.n, w = this.window;
  if (this.refresh-- <= 0 || !this.initialized) {
    this.refresh = 255;
    var progress = clamp((rpm - 750) / 3800, 0, 1);
    if (this.reverse) progress = 1 - progress;
    var middle = progress * (n - 1);
    this.regionStart = clamp(middle - w * .5, 0, n - w - 2);
    this.regionEnd = this.regionStart + w;
    if (!this.initialized) {
      this.position = clamp(middle, this.regionStart, this.regionEnd - this.fadeSource);
      this.initialized = true;
    } else if (this.fadeIndex < 0 &&
        (this.position < this.regionStart - .13 * t.rate || this.position > this.regionEnd)) {
      this._seek(this.regionStart + this.fadeSource * .35);
    }
  }

  if (this.fadeIndex < 0 && this.position >= this.regionEnd - this.fadeSource) {
    this._seek(this.regionStart);
  }
  var s;
  if (this.fadeIndex >= 0) {
    var a = this.fadeIndex / this.fadeLength;
    // Equal-power overlap: avoid gain dips when combining different phases.
    var g1 = Math.cos(a * Math.PI * .5), g2 = Math.sin(a * Math.PI * .5);
    s = lerp(t.buf, this.fadeFrom) * g1 + lerp(t.buf, this.fadeTo) * g2;
    this.fadeFrom += this.step;
    this.fadeTo += this.step;
    this.fadeIndex++;
    if (this.fadeIndex >= this.fadeLength) {
      this.position = this.fadeTo;
      this.fadeIndex = -1;
    }
  } else {
    s = lerp(t.buf, this.position);
    this.position += this.step;
  }
  return s;
};
function B57Samples(outRate,dir) {
  this.rate=outRate||44100;
  this.dir=dir||__dirname;
  this.ok=false;this.error=null;
  this.mixIdle=1;this.mixAccel=0;
  try {
    this.idle=new IdleStream(readWav(path.join(this.dir,'b57_idle.wav')),this.rate);
    this.accel=new MovingStream(readWav(path.join(this.dir,'b57_accel.wav')),this.rate,false);
    this.decel=new MovingStream(readWav(path.join(this.dir,'b57_decel.wav')),this.rate,true);
    this.ok=true;
  } catch(e) { this.error='B57 WAV nicht verfuegbar: '+e.message; }
}
B57Samples.prototype.render=function(out,off,n,amp,ampStep,rpm,load,overrun,intensity) {
  var peak=0, o=off*2, i, v, a;
  if(!this.ok) {
    for(i=0;i<n;i++){out[o++]=0;out[o++]=0;}
    return {peak:0,amp:amp+ampStep*n};
  }
  var desiredIdle=clamp((1550-rpm)/850,0,1);
  var desiredAccel=overrun?0:clamp((load-.04)/.63,0,1);
  var smoothing = 1 / (this.rate * .14);
  var idleMix = this.mixIdle, accelMix = this.mixAccel;
  // Even in steady cruising: soft mechanical presence; high load produces full accel sample.
  var driveGain=.55+.55*load*intensity;
  for(i=0;i<n;i++){
    idleMix += (desiredIdle - idleMix) * smoothing;
    accelMix += (desiredAccel - accelMix) * smoothing;
    var idle=this.idle.next();
    var acceleration=this.accel.next(rpm);
    var deceleration=this.decel.next(rpm);
    var running=deceleration*(1-accelMix)+acceleration*accelMix;
    v=(idle*idleMix+running*(1-idleMix))*driveGain;
    amp+=ampStep;
    // Slight saturation to avoid digital peaks; maintain dynamic headroom.
    v=v*amp*1.15;
    v=v/(1+Math.abs(v)*.17);
    v=clamp(v,-.95,.95);
    out[o++]=v;out[o++]=v;
    a=Math.abs(v);if(a>peak) peak=a;
  }
  this.mixIdle=idleMix;this.mixAccel=accelMix;
  return {peak:peak,amp:amp};
};
module.exports=B57Samples;
