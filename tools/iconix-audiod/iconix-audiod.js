'use strict';
/*
 * iconix-audiod – Audio-Dienst für Iconix Sounds (EXPERIMENTELL)
 *
 * Läuft als systemd-Dienst (Root-Tool des mgu-store) auf dem Head Unit mit dessen Node 8.
 * Empfängt von der App über Unix-Sockets Drehzahl/Last/Tempo und Einstellungen und gibt den Sound
 * über engine.js aus (Synthese + aplay/pacat/pw-cat/gst).
 *
 * Erreichbarkeit für die App (die ohne Root läuft):
 *   - Sockets: /run/iconix-audiod/audiod.sock (systemd RuntimeDirectory) und /tmp/iconix-audiod.sock
 *     (/tmp ist auf dem Head Unit ein gemeinsames tmpfs aller Prozesse – das Kit legt dort seine Frames ab)
 *   - Statusdatei /tmp/iconix-audiod.json (alle 2 s), damit die App auch ohne Socket sieht, dass der Dienst läuft
 *
 * Kommandozeile (auch am PC nutzbar):
 *   node iconix-audiod.js                     Dienst starten
 *   node iconix-audiod.js --probe             verfügbare Abspielprogramme anzeigen
 *   node iconix-audiod.js --play-test         9 s Test-Sweep direkt abspielen
 *   node iconix-audiod.js --wav out.wav [--profile v8] [--seconds 10] [--pops] [--volume 0.8]
 *
 * Umgebungsvariablen:
 *   ICONIX_AUDIOD_SOCKET  zusätzlicher/ersetzender Socket-Pfad (Tests: Named Pipe unter Windows)
 *   ICONIX_STATUS_FILE    Pfad der Statusdatei (Standard /tmp/iconix-audiod.json)
 *   sowie die von engine.js (ICONIX_PLAYER, ICONIX_DEVICE, ICONIX_RATE, ICONIX_LEAD_MS, ICONIX_BUFFER_US)
 *
 * Nur Node-8-kompatible Syntax verwenden.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const Synth = require('./synth');
const Profiles = require('./profiles');
const E = require('./engine');

const VERSION = '0.5.4';
const SOCKETS = process.env.ICONIX_AUDIOD_SOCKET
  ? [process.env.ICONIX_AUDIOD_SOCKET]
  : ['/run/iconix-audiod/audiod.sock', '/tmp/iconix-audiod.sock'];
const STATUS_FILE = process.env.ICONIX_STATUS_FILE || '/tmp/iconix-audiod.json';

// ALSA-Scan als nummerierte Zeilen (Nummer = Einstellung "Gerät N")
function scanLines(st) {
  if (!st.scan) return [st.scanError ? 'ALSA-Scan: ' + st.scanError : 'ALSA-Scan: läuft noch …'];
  if (!st.scan.length) return ['ALSA-Scan: keine Geräte' + (st.scanError ? ' (' + st.scanError + ')' : '')];
  let n = 0;
  return ['ALSA-Geräte (Nummer = Einstellung "Gerät N"):'].concat(st.scan.map(function (x) {
    if (x.ok) return '  ' + (++n) + ') ' + x.name + ' – lässt sich öffnen';
    if (x.silent) return '  -  ' + x.name + ' – stumm (verwirft den Ton)';
    return '  -  ' + x.name + ' – ' + String(x.error || 'Fehler').replace(/^(open|set_params): /, '');
  }));
}

function log(msg) { console.log(new Date().toISOString() + ' iconix-audiod: ' + msg); }

// ---------------------------------------------------------------------------
// Dienst
// ---------------------------------------------------------------------------
function runDaemon() {
  const clients = new Set();
  const servers = [];
  let lastLine = '', lastSent = 0;

  const engine = new E.Engine({ log: log, onStatus: function () { broadcast(false); } });

  function status() {
    const s = engine.status();
    s.op = 'status'; s.version = VERSION; s.via = 'daemon'; s.at = Date.now();
    s.sockets = servers.filter(function (x) { return x.ok; }).map(function (x) { return x.path; });
    return s;
  }
  function broadcast(onlyIfChanged) {
    const line = JSON.stringify(status()) + '\n';
    const now = Date.now();
    if (onlyIfChanged && line.replace(/"at":\d+,?/, '') === lastLine.replace(/"at":\d+,?/, '') && now - lastSent < 5000) return;
    lastLine = line; lastSent = now;
    clients.forEach(function (c) { try { c.write(line); } catch (e) { /* egal */ } });
  }
  function writeStatusFile() {
    try {
      const tmp = STATUS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(status()));
      try { fs.chmodSync(tmp, 420 /* 0644 */); } catch (e) { /* egal */ }
      fs.renameSync(tmp, STATUS_FILE);
    } catch (e) { /* /tmp nicht beschreibbar: egal */ }
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'params') engine.params(m);
    else if (m.op === 'config') { engine.configure(m.cfg); }
    else if (m.op === 'route') { engine.routeLease(m.granted === true); }
    else if (m.op === 'test') { log('Testsound'); engine.test(); }
    else if (m.op === 'stoptest') { engine.stopTest(); }
    else if (m.op === 'scan') { log('ALSA-Scan'); engine.scanDevices(function () { broadcast(false); }); }
    else if (m.op === 'testdevices') { log('Gerätetest'); engine.testDevices(); }
    else if (m.op === 'hello') log('App verbunden: ' + m.id + ' ' + m.version);
    else if (m.op === 'diag') {
      let lines;
      try {
        const sx = E.probeSmartx();
        engine.smartx = sx;
        log('SmartX: ' + JSON.stringify(sx));
        const r = E.probeAudio();
        log('Diagnose: ' + JSON.stringify(r));
        lines = E.smartxLines(sx).concat(['--- Allgemein (root) ---'], E.diagLines(r, []));
      } catch (e) { lines = ['Diagnose fehlgeschlagen: ' + e.message]; }
      const msg = JSON.stringify({ op: 'diag', lines: lines }) + '\n';
      clients.forEach(function (c) { try { c.write(msg); } catch (e) { /* egal */ } });
    }
  }

  function listen(p) {
    const entry = { path: p, ok: false };
    servers.push(entry);
    const isPipe = p.indexOf('\\\\.\\pipe\\') === 0;
    if (!isPipe) {
      try { fs.mkdirSync(path.dirname(p), 493 /* 0755 */); } catch (e) { /* gibt es schon */ }
      try { fs.unlinkSync(p); } catch (e) { /* gab keinen */ }
    }
    const server = net.createServer(function (sock) {
      clients.add(sock);
      sock.setEncoding('utf8');
      let rx = '';
      sock.on('data', function (d) {
        rx += d;
        let i;
        while ((i = rx.indexOf('\n')) >= 0) {
          const line = rx.slice(0, i); rx = rx.slice(i + 1);
          if (!line) continue;
          try { onMessage(JSON.parse(line)); } catch (e) { /* kaputte Zeile ignorieren */ }
        }
        if (rx.length > 65536) rx = '';
      });
      sock.on('error', function () { /* close folgt */ });
      sock.on('close', function () { clients.delete(sock); });
      try { sock.write(JSON.stringify(status()) + '\n'); } catch (e) { /* egal */ }
    });
    server.on('error', function (e) { log('Socket ' + p + ': ' + e.message); });
    server.listen(p, function () {
      entry.ok = true;
      if (!isPipe) { try { fs.chmodSync(p, 438 /* 0666: die App läuft ohne Root */); } catch (e) { log('chmod ' + p + ': ' + e.message); } }
      log('lauscht auf ' + p);
    });
    entry.server = server;
  }

  SOCKETS.forEach(listen);
  engine.start();
  // ALSA-Geräte einmal beim Start prüfen (Python + libasound), Ergebnis steht in Status und Diagnose
  setTimeout(function () { engine.scanDevices(function () { broadcast(false); }); }, 1500);
  const st = engine.status();
  log('Version ' + VERSION + ' – ' + (st.players.length ? 'Ausgabe: ' + st.players.join(', ') : st.error));

  setInterval(function () { broadcast(true); }, 1000);
  writeStatusFile();
  setInterval(writeStatusFile, 2000);

  function shutdown() {
    log('beende');
    engine.stop();
    servers.forEach(function (s) {
      try { s.server.close(); } catch (e) { /* egal */ }
      if (s.path.indexOf('\\\\.\\pipe\\') !== 0) { try { fs.unlinkSync(s.path); } catch (e) { /* egal */ } }
    });
    try { fs.unlinkSync(STATUS_FILE); } catch (e) { /* egal */ }
    setTimeout(function () { process.exit(0); }, 400);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', function (e) { log('Fehler: ' + (e && e.stack || e)); });
}

// ---------------------------------------------------------------------------
// Werkzeuge
// ---------------------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && process.argv[i + 1].indexOf('--') !== 0 ? process.argv[i + 1] : def;
}

function renderWav(file) {
  const RATE = E.RATE;
  const profile = arg('--profile', Profiles.DEFAULT);
  const seconds = Number(arg('--seconds', '9'));
  const synth = new Synth(RATE);
  synth.configure({
    profile: profile, volume: Number(arg('--volume', '0.8')), pops: process.argv.indexOf('--pops') >= 0,
    intensity: Number(arg('--intensity', '0.7'))
  });
  synth._setProfile(Profiles.get(profile).id); synth.pending = null;
  const frames = Math.floor(seconds * RATE);
  const pcm = Buffer.alloc(frames * 4);
  const block = 512, f32 = new Float32Array(block * 2);
  let peak = 0;
  for (let pos = 0; pos < frames; pos += block) {
    const n = Math.min(block, frames - pos);
    synth.setParams(E.sweepAt(pos / RATE, synth.cfg));
    peak = Math.max(peak, synth.render(f32, n));
    E.toPcm(f32, n).copy(pcm, pos * 4);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
  console.log(file + ': ' + Profiles.get(profile).name + ', ' + seconds + ' s, Spitze ' + peak.toFixed(3));
}

function playTest() {
  const engine = new E.Engine({ log: log });
  engine.configure({ profile: arg('--profile', Profiles.DEFAULT), volume: 0.7 });
  if (!engine.status().players.length) { console.error('Kein Abspielprogramm: ' + engine.status().error); process.exit(1); }
  engine.test();
  engine.start();
  setTimeout(function () { engine.stop(); setTimeout(function () { process.exit(0); }, 500); }, 9500);
}

if (require.main === module) {
  if (process.argv.indexOf('--probe') >= 0) {
    const list = E.candidates();
    console.log(list.length ? list.map(function (b) { return b.name + '  ' + b.path + ' ' + b.argv.join(' '); }).join('\n') : 'Kein Abspielprogramm gefunden.');
  } else if (process.argv.indexOf('--wav') >= 0) {
    renderWav(arg('--wav', 'iconix.wav'));
  } else if (process.argv.indexOf('--play-test') >= 0) {
    playTest();
  } else {
    runDaemon();
  }
}

module.exports = { sweepAt: E.sweepAt, toPcm: E.toPcm, candidates: E.candidates };
