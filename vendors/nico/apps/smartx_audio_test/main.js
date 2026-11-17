'use strict';
/* SmartX Audio Test: opt-in short tone, stopped vehicle, no permanent music source. */
const net = require('net');
const path = require('path');
const mgu = require('./kit/mgu');
const { createCarAudio } = require('./car_audio');
const SOCK = '/run/smartx-testd/probe.sock';
const FALLBACK = '/tmp/smartx-testd.sock';
const RATE_LIMIT_MS = 15000;
function ask(socket, op, timeout) {
  return new Promise(function (resolve) {
    let finished = false, data = '', c = null;
    const end = function (x) { if (finished) return; finished = true; clearTimeout(timer); try { c.destroy(); } catch(e) {} resolve(x); };
    const timer = setTimeout(function () { end({ok:false,error:'Zeitueberschreitung'}); }, timeout || 5000);
    try {
      c = net.connect(socket);
      c.setEncoding('utf8');
      c.on('connect', function () { c.write(JSON.stringify({ op: op })+'\n'); });
      c.on('data', function (b) { data += b; const i=data.indexOf('\n'); if(i>=0) { try { end(JSON.parse(data.slice(0,i))); } catch(e) { end({ok:false,error:'Ungueltige Antwort'}); } } });
      c.on('error', function (e) { end({ok:false,error:e.message}); });
    } catch(e) { end({ok:false,error:e.message}); }
  });
}
async function request(op) {
  let r = await ask(SOCK, op);
  if (r && r.error && /ENOENT|ECONNREFUSED/.test(r.error)) r=await ask(FALLBACK,op);
  return r;
}
function speedFrom(v) {
  const n = typeof v === 'number' ? v : (v && typeof v.speedVehicleCentreOfGravity === 'number' ? v.speedVehicleCentreOfGravity : NaN);
  return n === 65535 || !isFinite(n) ? null : n*0.015625;
}
mgu.run({
  async start(ctx) {
    const log = ctx.log || console;
    const carAudio = createCarAudio(ctx.signals, log, { file: ctx.dataDir ? path.join(ctx.dataDir,'smartx-route-owned.json') : null });
    let speed=null, speedAt=0, routeBusy=false, lastTest=0, status='Bereit: erst Dienst pruefen', detail='Kein Ton automatisch beim Start';
    let result='', destroyed=false, watchdog=null;
    function setMsg(s,d) { status=s; detail=d||''; }
    function parked() { return Date.now()-speedAt < 5000 && speed !== null && speed < 0.5; }
    async function release() {
      if (watchdog) { clearTimeout(watchdog); watchdog=null; }
      try { await carAudio.want(false); } catch(e) { log.warn('SmartX release: '+e); }
    }
    if (ctx.signals && ctx.signals.watch) {
      ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2','1',{
        statusCarSpeed2:function (v) { speed=speedFrom(v); speedAt=Date.now(); if(routeBusy && !parked()) { setMsg('ABBRUCH','Fahrzeug bewegt sich / Tempo nicht aktuell'); request('stop'); release(); } }
      },log).then(function(w){ if(w && w.error) log.warn('SmartX speed: '+w.error); })
        .catch(function(e){log.warn('SmartX speed: '+e);});
    }
    async function check() {
      const r=await request('status');
      if(r && r.ok) setMsg('Testdienst erreichbar','Geraet: '+r.device+'; kein Sound gestartet');
      else setMsg('Testdienst nicht erreichbar',(r && r.error || 'Iconix SmartX Test Tool installieren'));
    }
    async function test() {
      if(destroyed || routeBusy) return;
      if(!parked()) return setMsg('Test verweigert','Tempo unklar oder Fahrzeug bewegt sich. Nur im Stand.');
      if(Date.now()-lastTest<RATE_LIMIT_MS) return setMsg('Bitte nicht wiederholen','Zwischen Tests mindestens 15 Sekunden lassen');
      lastTest=Date.now(); routeBusy=true;
      setMsg('Test laeuft','Verbindung nur kurzzeitig, Ton ca. 1 Sekunde');
      // App/route watchdog. A crashed app can be recovered on next start via car_audio.js.
      watchdog=setTimeout(function(){request('stop');release();setMsg('Sicherheits-Stopp','Timeout der Route');},6500);
      try {
        const r0=await request('status');
        if(!r0 || !r0.ok) throw Error('Testdienst nicht erreichbar: '+(r0 && r0.error));
        if(!parked()) throw Error('Keine gueltigen Stillstandsdaten');
        await carAudio.want(true);
        const rt=carAudio.state();
        if(rt.taken) throw Error('CarLife-Quelle 287 wird bereits von anderer App genutzt');
        if(!rt.connected) throw Error('AudioManager-Routing: '+(rt.error||'nicht verbunden'));
        if(!parked()) throw Error('Stillstand nicht mehr bestaetigt');
        const r=await request('test');
        if(r && r.ok) setMsg('Test abgeschlossen','War ein leiser Ton hoerbar? '+(r.output||''));
        else throw Error('SmartX-Ton fehlgeschlagen: '+(r && r.error || 'ohne Antwort'));
      } catch(e) { setMsg('Test fehlgeschlagen',String(e.message||e)); }
      finally { await release(); routeBusy=false; }
    }
    function stop() { request('stop'); release(); routeBusy=false;setMsg('Gestoppt','Die App versucht, nur ihre eigene Audioverbindung freizugeben'); }
    ctx.ui.onClick('BTN_TEST',function(){test().catch(function(e){ setMsg('Fehler',String(e));release();routeBusy=false; });});
    ctx.ui.onClick('BTN_STOP',stop);
    ctx.ui.onClick('BTN_CHECK',function(){check().catch(function(e){setMsg('Fehler',String(e));});});
    if(ctx.app && ctx.app.on) ctx.app.on('shutdown',function(){destroyed=true;request('stop');release();});
    ctx.loop('MAIN',2,function(){
      const cv=ctx.canvas(1400,500);
      cv.clear('#0c1622');
      cv.text('SMARTX AUDIO TEST',52,92,47,'#f0f7ff',{font:'bold',literal:true});
      cv.text('Diagnose des BMW-Audiowegs – kein B57-Dauersound',52,144,24,'#98bdd5',{literal:true});
      cv.roundRect(50,176,1290,195,18,'#1d3040');
      cv.text(status,80,245,36,'#e7f8ff',{font:'bold',literal:true});
      cv.text(String(detail).slice(0,100),80,310,22,'#a4c5dd',{literal:true});
      const s=Date.now()-speedAt<5000 && speed!==null ? speed.toFixed(1)+' km/h' : 'unbekannt';
      cv.text('Fahrzeugtempo: '+s+' | Test nur bei 0 km/h',52,432,23,'#ffcc81',{literal:true});
      cv.text('Max. ca. 1 Sek. leiser Testton; CarPlay kann unterbrochen werden',52,472,20,'#9cbacb',{literal:true});
      return ctx.ui.image('MAIN_GFX',cv);
    });
    await check();
  }
});
