'use strict';
/* SmartX Audio Test 0.1.2: short opt-in tone, explicit manual parked confirmation when Vehicle2 speed is unavailable. */
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
    let speed=null, speedAt=0, routeBusy=false, lastTest=0, armedUntil=0, status='Bereit: Dienst pruefen', detail='Nur im geparkten Fahrzeug testen';
    let destroyed=false, watchdog=null, phase='Bereit';
    function setMsg(s,d) { status=s; detail=d||''; }
    function speedKnown() { return Date.now()-speedAt < 5000 && speed !== null; }
    // A KNOWN nonzero speed always blocks a test. Unknown speed requires a conscious,
    // short-lived confirmation of being parked; never infer 0 from a missing signal.
    function confirmedParked() { return speedKnown() ? speed < 0.5 : Date.now() < armedUntil; }
    function arm() {
      if (routeBusy) return setMsg('Test laeuft','Bitte erst den laufenden Test beenden');
      if (speedKnown() && speed >= 0.5) { armedUntil=0; return setMsg('Test verweigert','Fahrzeug bewegt sich; Test nur geparkt'); }
      armedUntil=Date.now()+30000;
      setMsg('Im Stand bestaetigt','Innerhalb von 30 Sek. einmal TESTTON druecken; nur bei sicher geparktem BMW');
    }
    async function release() {
      if (watchdog) { clearTimeout(watchdog); watchdog=null; }
      try { await carAudio.want(false); } catch(e) { log.warn('SmartX release: '+e); }
    }
    // At 0 km/h, Vehicle2 may not publish any change notifications.
    // Request its getter every 2 seconds as well; NEVER assume missing speed means stopped.
    // This is the same polling approach used by the upstream MGU parked watcher.
    let speedSource = 'warten auf Vehicle2';
    if (ctx.signals && ctx.signals.watch) {
      ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2','1',{
        statusCarSpeed2:function (v) {
          speed=speedFrom(v); speedAt=Date.now();
          speedSource = speed === null ? 'ungueltiger Fahrzeugwert' : 'Vehicle2 aktiv';
          if(routeBusy && speedKnown() && speed >= 0.5) { setMsg('ABBRUCH','Fahrzeug bewegt sich'); request('stop'); release(); }
        }
      },log,{pollMs:2000}).then(function(w){
        if (w && w.error) { speedSource='Vehicle2 Fehler'; log.warn('SmartX speed: '+w.error); }
        else if (w && !w.available && speed === null) { speedSource='Vehicle2 nicht erreichbar'; }
      }).catch(function(e){ speedSource='Vehicle2 Abfragefehler'; log.warn('SmartX speed: '+e); });
    } else { speedSource='keine Fahrzeugsignal-API'; }
    async function check() {
      const r=await request('status');
      if(r && r.ok) setMsg('Testdienst erreichbar','Geraet: '+r.device+'; kein Sound gestartet');
      else setMsg('Testdienst nicht erreichbar',(r && r.error || 'Iconix SmartX Test Tool installieren'));
    }
    async function test() {
      if(destroyed || routeBusy) return;
      if(!confirmedParked()) return setMsg('Test verweigert', speedKnown() ? 'Fahrzeug bewegt sich. Nur im Stand.' : 'Tempo unbekannt. Bitte zuerst STILLSTAND BESTAETIGEN.');
      if(Date.now()-lastTest<RATE_LIMIT_MS) return setMsg('Bitte nicht wiederholen','Zwischen Tests mindestens 15 Sekunden lassen');
      lastTest=Date.now(); routeBusy=true; armedUntil=0; phase='Dienst';
      setMsg('Test laeuft','Verbindung nur kurzzeitig, Ton ca. 1 Sekunde');
      // App/route watchdog. A crashed app can be recovered on next start via car_audio.js.
      watchdog=setTimeout(function(){request('stop');release();setMsg('Sicherheits-Stopp','Timeout der Audio-Route. STOP druecken, falls Ton weiterlaeuft.');},9000);
      try {
        const r0=await request('status');
        if(!r0 || !r0.ok) throw Error('Testdienst nicht erreichbar: '+(r0 && r0.error));
        if(speedKnown() && speed >= 0.5) throw Error('Fahrzeug bewegt sich');
        phase='AudioManager verbinden'; await carAudio.want(true);
        const rt=carAudio.state();
        if(rt.taken) throw Error('CarLife-Quelle 287 wird bereits von anderer App genutzt');
        if(rt.error) throw Error('AudioManager-Routing: '+rt.error);
        if(!rt.connected) throw Error('AudioManager-Routing: '+(rt.error||'nicht verbunden'));
        if(speedKnown() && speed >= 0.5) throw Error('Fahrzeug bewegt sich');
        phase='SmartX PCM'; const r=await request('test');
        if(r && r.ok) setMsg('Test abgeschlossen','War ein leiser Ton hoerbar? '+(r.output||''));
        else throw Error('SmartX-Ton fehlgeschlagen: '+(r && r.error || 'ohne Antwort'));
      } catch(e) { setMsg('Test fehlgeschlagen',String(e.message||e)); }
      finally {
        phase='Freigabe';
        await release();
        routeBusy=false;
        const rt=carAudio.state();
        if(rt.id != null || rt.connected || rt.error) {
          setMsg('Audio-Freigabe pruefen','AudioManager: '+(rt.error||('Verbindung '+rt.id+' noch vorhanden'))+'; STOP druecken');
        }
      }
    }
    async function stop() {
      armedUntil=0;
      await request('stop');
      await release();
      routeBusy=false;
      const r=carAudio.state();
      setMsg(r.id!=null || r.error ? 'Freigabe kontrollieren' : 'Gestoppt',r.error||'Nur die eigene Verbindung wird freigegeben');
    }
    ctx.ui.onClick('BTN_ARM',arm);
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
      const s=speedKnown() ? speed.toFixed(1)+' km/h' : 'unbekannt ('+speedSource+')';
      cv.text('Fahrzeugtempo: '+s,52,425,23,'#ffcc81',{literal:true});
      const ar=armedUntil>Date.now() ? 'Manuelle Freigabe: '+Math.ceil((armedUntil-Date.now())/1000)+' Sek.' : 'Bei Tempo unbekannt: STILLSTAND BESTAETIGEN';
      cv.text(ar+' | Phase: '+phase,52,451,19,'#9dc5e5',{literal:true});
      cv.text('Nur geparkt, 1 Sek. leise; CarPlay koennte unterbrochen werden',52,478,19,'#9cbacb',{literal:true});
      return ctx.ui.image('MAIN_GFX',cv);
    });
    await check();
  }
});
