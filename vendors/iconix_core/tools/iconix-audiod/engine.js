'use strict';
/*
 * Iconix Sounds – Audio-Kern (nur Node, Node-8-kompatibel)
 *
 * Synthese (synth.js) + Abspielprogramm (aplay/pacat/pw-cat/gst) + Taktgeber. Wird genutzt von:
 *   - tools/iconix-audiod/iconix-audiod.js  (Root-Dienst, Socket-Server)
 *   - apps/iconix_sounds/audio_link.js      (Rückfall: Ton direkt aus der App, wenn der Dienst fehlt)
 * Kanonische Quelle: shared/engine.js – Kopien erzeugt `npm run sync`.
 *
 *   const eng = new Engine({ log: fn, onStatus: st => ... });
 *   eng.configure(cfg); eng.params({ rpm, load, speed, overrun }); eng.test(); eng.start(); eng.stop();
 *
 * Umgebungsvariablen: ICONIX_RATE, ICONIX_LEAD_MS, ICONIX_BUFFER_US, ICONIX_PLAYER, ICONIX_DEVICE
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const Synth = require('./synth');

const RATE = Number(process.env.ICONIX_RATE) || 48000; // SmartX CarLife media uses 48 kHz
const TICK_MS = 20;          // 50 Wakeups/s (Blöcke à 882 Samples) – schont die CPU
// so viel Audio liegt höchstens vor (muss > TICK_MS + Jitter des Head Units sein). 160 ms gibt Reserve,
// wenn Node auf dem Head Unit kurz hängt (GC, andere Apps) – sonst knackt/stottert es (Underrun).
const LEAD_MS = Number(process.env.ICONIX_LEAD_MS) || 160;
// The regular ALSA route keeps conservative buffering; SmartX is separately tunable.
const SMARTX_LEAD_MS = Number(process.env.ICONIX_SMARTX_LEAD_MS) || 80;
const SMARTX_BUFFER_US = Number(process.env.ICONIX_SMARTX_BUFFER_US) || 120000;
const BUFFER_US = Number(process.env.ICONIX_BUFFER_US) || 200000; // Puffer des Abspielprogramms
const STALE_MS = 1500;       // ohne Daten -> ausblenden
const IDLE_STOP_MS = 8000;   // so lange still -> Abspielprogramm beenden (gibt das Audiogerät frei)
const MAX_CHUNK = 4096;

// ---------------------------------------------------------------------------
// Abspielprogramme
// ---------------------------------------------------------------------------
const BACKENDS = [
  {
    name: 'aplay', bin: 'aplay',
    args: function (r) {
      const a = ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(r), '-c', '2', '--buffer-time=' + BUFFER_US, '--period-time=' + Math.round(BUFFER_US / 4)];
      if (process.env.ICONIX_DEVICE) a.push('-D', process.env.ICONIX_DEVICE);
      a.push('-');
      return a;
    }
  },
  {
    name: 'pacat', bin: 'pacat',
    args: function (r) { return ['--playback', '--raw', '--format=s16le', '--rate=' + r, '--channels=2', '--latency-msec=' + Math.round(BUFFER_US / 1000)]; }
  },
  {
    name: 'pw-cat', bin: 'pw-cat',
    args: function (r) { return ['--playback', '--format', 's16', '--rate', String(r), '--channels', '2', '-']; }
  },
  {
    name: 'paplay', bin: 'paplay',
    args: function (r) { return ['--raw', '--format=s16le', '--rate=' + r, '--channels=2', '--latency-msec=' + Math.round(BUFFER_US / 1000)]; }
  },
  {
    name: 'sox', bin: 'play',
    args: function (r) { return ['-q', '-t', 'raw', '-r', String(r), '-e', 'signed', '-b', '16', '-c', '2', '-']; }
  },
  {
    name: 'ffplay', bin: 'ffplay',
    args: function (r) { return ['-nodisp', '-loglevel', 'error', '-f', 's16le', '-ar', String(r), '-ac', '2', '-i', '-']; }
  },
  {
    name: 'gstreamer', bin: 'gst-launch-1.0',
    args: function (r) {
      return ['-q', 'fdsrc', 'fd=0', '!', 'rawaudioparse', 'format=pcm', 'pcm-format=s16le',
        'sample-rate=' + r, 'num-channels=2', '!', 'audioconvert', '!', 'audioresample', '!', 'autoaudiosink'];
    }
  }
];

function findBin(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter)
    .concat(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/bin']);
  for (let i = 0; i < dirs.length; i++) {
    if (!dirs[i]) continue;
    const p = path.join(dirs[i], bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* weiter */ }
  }
  return null;
}

// Python finden: PATH, dann die Store-Tools unter /var/opt (mgu-python bringt Python 3.12 mit)
let pythonCache;
function findPython() {
  if (pythonCache !== undefined) return pythonCache;
  pythonCache = null;
  if (process.env.ICONIX_PYTHON) { pythonCache = process.env.ICONIX_PYTHON; return pythonCache; }
  const names = ['python3', 'python3.12', 'python'];
  for (let i = 0; i < names.length; i++) { const p = findBin(names[i]); if (p) { pythonCache = p; return p; } }
  const rels = ['current/bin/python3', 'current/bin/python3.12', 'current/python3', 'current/python/bin/python3',
    'current/usr/bin/python3', 'bin/python3'];
  let dirs = [];
  try { dirs = fs.readdirSync('/var/opt'); } catch (e) { dirs = []; }
  dirs.sort(function (a, b) { return (/python/.test(b) ? 1 : 0) - (/python/.test(a) ? 1 : 0); });
  for (let i = 0; i < dirs.length; i++) {
    for (let j = 0; j < rels.length; j++) {
      const p = path.join('/var/opt', dirs[i], rels[j]);
      try { fs.accessSync(p, fs.constants.X_OK); pythonCache = p; return p; } catch (e) { /* weiter */ }
    }
  }
  return null;
}

function hasLibasound() {
  const dirs = ['/usr/lib', '/lib', '/usr/lib64', '/lib64', '/usr/lib/x86_64-linux-gnu'];
  for (let i = 0; i < dirs.length; i++) { if (fs.existsSync(path.join(dirs[i], 'libasound.so.2'))) return true; }
  return false;
}

const ALSA_SCRIPT = path.join(__dirname, 'alsa_play.py');
// Geräte, die "auto" der Reihe nach probiert (das erste, das sich öffnen lässt, gewinnt)
const AUTO_DEVICES = ['default', 'plughw:0,0', 'plughw:0,1'];
const SMARTX_DEVICE = 'plug:smartx:CarLifeMedia_CF_48_STEREO';

/**
 * Abspielwege in Reihenfolge. opts.device: ALSA-Gerät für den Python-Player ('auto' = AUTO_DEVICES).
 */
function candidates(opts) {
  opts = opts || {};
  const out = [];
  if (process.env.ICONIX_PLAYER) {
    // "cmd arg arg" oder JSON-Array '["/pfad mit leerzeichen/cmd","arg"]'
    const raw = process.env.ICONIX_PLAYER.trim();
    let parts;
    try { parts = raw.charAt(0) === '[' ? JSON.parse(raw) : null; } catch (e) { parts = null; }
    if (!parts) parts = raw.split(/\s+/).filter(Boolean);
    parts = parts.map(function (s) { return String(s).replace('{rate}', String(RATE)); });
    out.push({ name: 'custom', path: parts[0], argv: parts.slice(1) });
  }
  // ALSA über Python + ctypes (das Head Unit hat libasound und mgu-python, aber kein aplay)
  const py = findPython();
  if (py && fs.existsSync(ALSA_SCRIPT) && (hasLibasound() || process.env.ICONIX_ALSA_FORCE)) {
    const dev = opts.device === 'smartx' ? [SMARTX_DEVICE] : (opts.device && opts.device !== 'auto' ? [opts.device] : AUTO_DEVICES);
    dev.forEach(function (d) {
      // "name@/pfad/zur/alsa.conf" = Gerät aus BMWs eigener ALSA-Konfiguration (ALSA_CONFIG_PATH)
      const at = d.indexOf('@/');
      const name = at > 0 ? d.slice(0, at) : d, cfg = at > 0 ? d.slice(at + 1) : null;
      out.push({ name: 'alsa:' + d, path: py, argv: [ALSA_SCRIPT, 'play', name, String(RATE), String(opts.device === 'smartx' ? SMARTX_BUFFER_US : BUFFER_US)], device: d,
        env: cfg ? { ALSA_CONFIG_PATH: cfg } : null });
    });
  }
  if (opts.device === 'smartx') return out; // never fall back to occupied/default playback
  BACKENDS.forEach(function (b) {
    const p = findBin(b.bin);
    if (p) out.push({ name: b.name, path: p, argv: b.args(RATE) });
  });
  return out;
}

/**
 * ALSA-Geräte auflisten und testweise öffnen (Python-Skript "list").
 * extra: zusätzliche Gerätenamen (z. B. aus BMWs ALSA-Konfiguration); cfg: ALSA_CONFIG_PATH oder null.
 * cb(err, { devices: [{ name, desc, ok, silent, error }] })
 */
function scanAlsa(extra, cfg, cb) {
  if (typeof extra === 'function') { cb = extra; extra = []; cfg = null; }
  const py = findPython();
  if (!py) return cb(new Error('kein Python gefunden'));
  if (!fs.existsSync(ALSA_SCRIPT)) return cb(new Error('alsa_play.py fehlt'));
  const env = cfg ? Object.assign({}, process.env, { ALSA_CONFIG_PATH: cfg }) : process.env;
  cp.execFile(py, [ALSA_SCRIPT, 'list'].concat(extra || []), { timeout: 30000, maxBuffer: 1 << 20, env: env }, function (e, stdout, stderr) {
    let res = null;
    try { res = JSON.parse(String(stdout).trim().split('\n').pop()); } catch (x) { res = null; }
    if (!res) return cb(new Error((e && e.message) || String(stderr).trim().slice(0, 160) || 'keine Antwort'));
    cb(null, res);
  });
}

// ---------------------------------------------------------------------------
// PCM-Ausgabe über ein Kindprozess-Abspielprogramm
// ---------------------------------------------------------------------------
function Output(onState, log, opts) {
  this.onState = onState || function () {};
  this.log = log || function () {};
  this.opts = opts || {};
  this.list = candidates(this.opts);
  this.bad = {};
  this.child = null;
  this.backend = null;
  this.blocked = false;
  this.underruns = 0;
  this.error = this.list.length ? null : 'kein Abspielprogramm gefunden – siehe Audio-Diagnose';
  this.lastErr = '';
}

Output.prototype.start = function () {
  if (this.child) return true;
  const self = this, log = this.log;
  const b = this.list.filter(function (x) { return !self.bad[x.name]; })[0];
  if (!b) {
    this.error = this.list.length ? 'alle Abspielprogramme fehlgeschlagen' + (this.lastErr ? ': ' + this.lastErr : '') : this.error;
    this.onState();
    return false;
  }
  log('starte ' + b.name + ' ' + b.path + ' ' + b.argv.join(' '));
  let child;
  try {
    child = cp.spawn(b.path, b.argv, { stdio: ['pipe', 'ignore', 'pipe'], env: b.env ? Object.assign({}, process.env, b.env) : process.env });
  } catch (e) {
    this.bad[b.name] = true; this.lastErr = e.message; this.onState();
    return false;
  }
  const startedAt = Date.now();
  this.child = child;
  this.backend = b.name;
  this.blocked = false;
  this.error = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (d) {
    const line = String(d).trim().split('\n').pop();
    if (!line) return;
    // aplay meldet Aussetzer als "underrun!!! (at least X ms long)" – zählen statt als Fehler werten
    if (/underrun|xrun/i.test(line)) {
      self.underruns++;
      if (self.underruns <= 5 || self.underruns % 50 === 0) log(b.name + ': ' + line + ' (#' + self.underruns + ')');
      return;
    }
    self.lastErr = line.slice(0, 120); log(b.name + ': ' + line);
  });
  child.stdin.on('error', function () { /* EPIPE -> exit folgt */ });
  child.stdin.on('drain', function () { self.blocked = false; });
  child.on('error', function (e) { self.lastErr = e.message; });
  child.on('exit', function (code, sig) {
    log(b.name + ' beendet, code ' + code + ' signal ' + sig);
    if (self.child === child) {
      self.child = null;
      self.backend = null;
      if (!self.stopping && Date.now() - startedAt < 3000) {
        self.bad[b.name] = true; // startet nicht -> nächstes Programm probieren
        self.error = b.name + ' fehlgeschlagen' + (self.lastErr ? ': ' + self.lastErr : '');
      }
      self.stopping = false;
      self.onState();
    }
  });
  this.onState();
  return true;
};

Output.prototype.stop = function () {
  if (!this.child) return;
  this.stopping = true;
  try { this.child.stdin.end(); } catch (e) { /* egal */ }
  const c = this.child;
  setTimeout(function () { try { c.kill('SIGTERM'); } catch (e) { /* egal */ } }, 300);
};

Output.prototype.write = function (buf) {
  if (!this.child || this.blocked) return false;
  const ok = this.child.stdin.write(buf);
  if (!ok) this.blocked = true;
  return true;
};

// Float32 interleaved -> S16LE Buffer (Int16Array-Sicht statt writeInt16LE pro Sample;
// x86 und ARM des Head Units sind little-endian). Buffer.alloc liefert immer byteOffset 0.
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function toPcm(f32, frames) {
  const n = frames * 2;
  const buf = Buffer.alloc(n * 2);
  if (LITTLE) {
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, n);
    for (let i = 0; i < n; i++) {
      const v = f32[i];
      i16[i] = v >= 1 ? 32767 : (v <= -1 ? -32767 : (v * 32767) | 0);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const v = f32[i];
      buf.writeInt16LE(v >= 1 ? 32767 : (v <= -1 ? -32767 : (v * 32767) | 0), i * 2);
    }
  }
  return buf;
}

// Test-Sweep: Leerlauf -> Vollgas bis Abregeldrehzahl -> Schub -> Teillast
function sweepAt(t, cfg) {
  const idle = cfg.carIdle || 800, red = cfg.carRedline || 4800;
  if (t < 0.8) return { rpm: idle, load: 0.05, speed: 0, overrun: false };
  if (t < 4.0) { const x = (t - 0.8) / 3.2; return { rpm: idle + (red - idle) * x, load: 1, speed: 120 * x, overrun: false }; }
  if (t < 5.5) { const x = (t - 4.0) / 1.5; return { rpm: red - (red - 1500) * x, load: 0, speed: 120 - 20 * x, overrun: true }; }
  if (t < 7.5) { const x = (t - 5.5) / 2; return { rpm: 1500 + 2000 * x, load: 0.5, speed: 100 + 20 * x, overrun: false }; }
  const x = Math.min(1, (t - 7.5) / 1.5);
  return { rpm: 3500 - (3500 - idle) * x, load: 0, speed: 120 * (1 - x), overrun: x < 0.9 };
}

// Geräte, die sich öffnen lassen und nicht stumm sind ("null" schluckt den Ton)
function isSilent(d) { return !!d.silent || /^null(@|:|$)/.test(d.name); }
function usable(scan) {
  return ((scan && scan.devices) || []).filter(function (x) { return x.ok && !isSilent(x); });
}

// ---------------------------------------------------------------------------
// Engine: Synth + Ausgabe + Taktgeber
// ---------------------------------------------------------------------------
function Engine(opts) {
  opts = opts || {};
  const self = this;
  this.log = opts.log || function () {};
  this.onStatus = opts.onStatus || function () {};
  this.synth = new Synth(RATE);
  this.device = opts.device || process.env.ICONIX_ALSA_DEVICE || 'auto';  // ALSA-Gerät oder 'auto' / 'scanN'
  this.scan = null;      // Ergebnis von scanAlsa
  this.devTest = null;   // laufender Gerätetest { list, i, until, prev }
  this.out = new Output(function () { self._changed(); }, this.log, { device: this._resolve(this.device) });
  this.lastParams = 0;
  this.testUntil = 0; this.testStart = 0;
  this.silentSince = 0;
  this.t0 = 0; this.written = 0;
  this.lastTick = Date.now(); this.late = 0;
  this.f32 = new Float32Array(MAX_CHUNK * 2);
  this.timer = null;
  this.routeUntil = 0; // SmartX requires an explicit, live AudioManager lease from the app
}

Engine.prototype.configure = function (cfg) {
  this.synth.configure(cfg);
  if (cfg && cfg.device && cfg.device !== this.device && !this.devTest) this.setDevice(cfg.device);
  this._changed();
};

// 'scanN' = das N-te Gerät, das sich beim Scan öffnen ließ (so in der Diagnose nummeriert)
Engine.prototype._resolve = function (d) {
  const m = /^scan(\d+)$/.exec(d || '');
  if (!m) return d || 'auto';
  const ok = usable(this.scan);
  const hit = ok[Number(m[1]) - 1];
  return hit ? hit.name : 'auto';
};

Engine.prototype.setDevice = function (d) {
  const self = this;
  this.device = d || 'auto';
  const old = this.out;
  this.out = new Output(function () { self._changed(); }, this.log, { device: this._resolve(this.device) });
  this.out.underruns = old.underruns || 0;
  old.stop();
  this.log('Ausgabegerät: ' + this.device + ' -> ' + this._resolve(this.device));
  this._changed();
};

Engine.prototype.scanDevices = function (cb) {
  const self = this;
  let sx = null;
  try { sx = probeSmartx(); } catch (e) { sx = null; }
  this.smartx = sx;
  const extra = sx ? sx.pcmNames : [];
  // Durchläufe: normale ALSA-Konfiguration, dann jede ALSA_CONFIG_PATH der BMW-Audio-Prozesse
  const runs = [null].concat(sx ? sx.alsaConfigEnv : []);
  const all = [];
  let firstErr = null;
  const next = function (i) {
    if (i >= runs.length) return done();
    scanAlsa(extra, runs[i], function (err, res) {
      if (err) { if (!firstErr) firstErr = err.message; }
      else (res.devices || []).forEach(function (d) {
        if (runs[i]) d.name = d.name + '@' + runs[i];
        all.push(d);
      });
      next(i + 1);
    });
  };
  const done = function () {
    self.scan = all.length ? { devices: all } : { devices: [], error: firstErr || 'keine Geräte' };
    self.log('ALSA-Scan: ' + JSON.stringify(self.scan));
    // ein Gerät "scanN" erst jetzt auflösbar
    if (/^scan/.test(self.device)) self.setDevice(self.device);
    self._changed();
    if (cb) cb(self.scan);
  };
  next(0);
};

/** Spielt den Testsound nacheinander auf jedem Gerät, das sich öffnen ließ (je 4 s). */
Engine.prototype.testDevices = function () {
  const self = this;
  const run = function () {
    const list = usable(self.scan).map(function (x) { return x.name; });
    if (!list.length) { self.log('Gerätetest: kein Gerät ließ sich öffnen'); self._changed(); return; }
    self.devTest = { list: list, i: -1, prev: self.device };
    self._nextTestDevice();
  };
  if (this.scan) run(); else this.scanDevices(run);
};

Engine.prototype._nextTestDevice = function () {
  const t = this.devTest;
  if (!t) return;
  t.i++;
  if (t.i >= t.list.length) {
    const prev = t.prev;
    this.devTest = null;
    this.testUntil = 0;
    this.setDevice(prev);
    return;
  }
  this.setDevice(t.list[t.i]);
  this.testStart = Date.now(); this.testUntil = this.testStart + 4000;
  t.until = this.testUntil;
  this._changed();
};
Engine.prototype.params = function (p) { this.synth.setParams(p); this.lastParams = Date.now(); };
// Only an app which successfully owns its AudioManager connection may keep PCM flowing.
// Heartbeat expires automatically if the app disappears; normal ALSA is unaffected.
Engine.prototype.routeLease = function (granted) { const was = this.routeActive(); this.routeUntil = granted ? Date.now() + 2300 : 0; if (!granted && this.device === 'smartx' && this.out.child && !this.out.stopping) this.out.stop(); if (was !== this.routeActive()) this._changed(); };
Engine.prototype.routeActive = function () { return this.device !== 'smartx' || Date.now() < this.routeUntil; };
Engine.prototype.stopTest = function () { this.testUntil = 0; this._testUnmuted = false; this.out.stop(); this._changed(); };
Engine.prototype.test = function () {
  this.testStart = Date.now(); this.testUntil = this.testStart + 9000;
  // nach einem Fehler beim Testsound alle Abspielprogramme erneut probieren
  this.out.bad = {};
  this.out.list = candidates({ device: this._resolve(this.device) });
  this.out.error = this.out.list.length ? null : 'kein Abspielprogramm gefunden – siehe Audio-Diagnose';
  this._changed();
};

Engine.prototype.status = function () {
  const out = this.out;
  const sampleError = this.synth.cfg.profile === 'b57_540d' && (!this.synth.b57 || !this.synth.b57.ok)
    ? ((this.synth.b57 && this.synth.b57.error) || 'B57 Soundmod-Dateien fehlen') : null;
  return {
    ok: !out.error && !sampleError,
    backend: out.backend || (out.list[0] && !out.error ? out.list[0].name : null),
    rate: RATE, playing: !!out.child, error: out.error || sampleError, profile: this.synth.cfg.profile,
    underruns: out.underruns || 0, late: this.late, leadMs: this.device === 'smartx' ? SMARTX_LEAD_MS : LEAD_MS,
    players: out.list.map(function (b) { return b.name; }),
    device: this.device, smartxRoute: this.device === 'smartx' ? this.routeActive() : null, python: findPython(),
    scan: this.scan ? (this.scan.devices || []).map(function (d) { return { name: d.name, ok: d.ok && !isSilent(d), silent: isSilent(d), error: d.error }; }) : null,
    scanError: this.scan && this.scan.error,
    devTest: this.devTest ? { device: this.devTest.list[this.devTest.i], i: this.devTest.i + 1, n: this.devTest.list.length } : null
  };
};

Engine.prototype._changed = function () { try { this.onStatus(this.status()); } catch (e) { /* egal */ } };

Engine.prototype.start = function () {
  if (this.timer) return;
  const self = this;
  this.lastTick = Date.now();
  this.timer = setInterval(function () { self._tick(); }, TICK_MS);
};

Engine.prototype.stop = function () {
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  this.out.stop();
};

Engine.prototype._tick = function () {
  const now = Date.now(), synth = this.synth, out = this.out;
  // zählt Wakeups, die so spät kamen, dass der Vorlauf aufgebraucht war
  const leadMs = this.device === 'smartx' ? SMARTX_LEAD_MS : LEAD_MS;
  if (out.child && now - this.lastTick > leadMs) this.late++;
  this.lastTick = now;
  if (this.devTest && now >= this.devTest.until) this._nextTestDevice();
  const testing = now < this.testUntil;
  if (testing) {
    synth.setParams(sweepAt((now - this.testStart) / 1000, synth.cfg));
    synth.stale = false;
  } else {
    synth.stale = now - this.lastParams > STALE_MS;
  }
  // Testsound auch bei "Stumm" hörbar machen
  const wantSound = (synth.cfg.enabled || testing) && (!synth.stale || testing) && this.routeActive() && !(synth.cfg.profile === 'b57_540d' && (!synth.b57 || !synth.b57.ok));
  // If the SmartX route is lost, stop writing immediately, not after idle timeout.
  if (this.device === 'smartx' && !this.routeActive()) {
    if (out.child && !out.stopping) out.stop();
    return;
  }
  if (testing && !synth.cfg.enabled) { synth.cfg.enabled = true; this._testUnmuted = true; }
  if (!testing && this._testUnmuted) { synth.cfg.enabled = false; this._testUnmuted = false; }

  if (wantSound) this.silentSince = 0;
  else if (!this.silentSince) this.silentSince = now;

  if (wantSound && !out.child && !out.error) {
    if (out.start()) { this.t0 = now; this.written = 0; }
  }
  if (out.child && this.silentSince && now - this.silentSince > IDLE_STOP_MS && synth.gain < 0.001) {
    this.log('still – gebe Audiogerät frei');
    out.stop();
  }
  if (!out.child) return;

  let due = Math.floor((now - this.t0 + leadMs) / 1000 * RATE) - this.written;
  // Do not catch up a large queue of stale audio after SmartX backpressure.
  // Limit to 250ms; ALSA default keeps the original 500ms limit.
  const maxLateFrames = this.device === 'smartx' ? RATE / 4 : RATE / 2;
  if (due > maxLateFrames) {
    this.t0 = now; this.written = 0;
    due = Math.floor(leadMs / 1000 * RATE);
  }
  while (due > 0 && !out.blocked && out.child) {
    const n = Math.min(due, MAX_CHUNK);
    synth.render(this.f32, n);
    out.write(toPcm(this.f32, n));
    this.written += n; due -= n;
  }
};

// ---------------------------------------------------------------------------
// Audio-Diagnose: was gibt es auf diesem Gerät, um Ton auszugeben?
// (aus Sicht des aufrufenden Prozesses – App ohne Root bzw. Dienst als root)
// ---------------------------------------------------------------------------
const AUDIO_RE = /(^a?play|^paplay|^ffplay|audio|snd|alsa|pcm|pulse|pipewire|^gst|tinyalsa|tinyplay|tinymix|avb|sound|mixer|gong|chime|speaker|mediaengine|mediaapp)/i;

function probeAudio(opts) {
  opts = opts || {};
  const ls = function (d) { try { return fs.readdirSync(d); } catch (e) { return null; } };
  const read = function (f, n) { try { return fs.readFileSync(f, 'utf8').slice(0, n || 4000); } catch (e) { return null; } };
  const can = function (p, mode) { try { fs.accessSync(p, mode); return true; } catch (e) { return false; } };
  const uniq = function (a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); };
  const r = { at: Date.now() };
  r.uid = process.getuid ? process.getuid() : null;
  r.players = candidates().map(function (b) { return b.name + ' ' + b.path; });
  r.python = findPython();
  r.alsaScript = fs.existsSync(ALSA_SCRIPT);
  // ALSA-Geräte im Kernel
  r.devSnd = ls('/dev/snd');
  r.devSndWritable = (r.devSnd || []).filter(function (n) { return /^pcm.*p$/.test(n) && can('/dev/snd/' + n, fs.constants.W_OK); });
  r.cards = read('/proc/asound/cards', 1500);
  r.pcm = read('/proc/asound/pcm', 1500);
  // OSS-Emulation: dorthin könnte Node ohne Abspielprogramm direkt schreiben
  r.oss = ['/dev/dsp', '/dev/dsp0', '/dev/audio'].filter(function (p) { return fs.existsSync(p); })
    .map(function (p) { return p + (can(p, fs.constants.W_OK) ? ' (schreibbar)' : ' (kein Zugriff)'); });
  // Bibliotheken
  const libs = [];
  ['/usr/lib', '/lib', '/usr/lib64', '/lib64', '/usr/lib/x86_64-linux-gnu'].forEach(function (d) {
    (ls(d) || []).forEach(function (n) { if (/^lib(asound|pulse|pipewire|tinyalsa|gstreamer|avb|ias)/i.test(n)) libs.push(n); });
  });
  r.libs = uniq(libs).slice(0, 30);
  // Programme mit Audio-Bezug
  const bins = [];
  (process.env.PATH || '').split(path.delimiter).concat(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/bin'])
    .forEach(function (d) { if (d) (ls(d) || []).forEach(function (n) { if (AUDIO_RE.test(n)) bins.push(n); }); });
  r.bins = uniq(bins).sort().slice(0, 60);
  // laufende Prozesse mit Audio-Bezug
  const procs = [];
  (ls('/proc') || []).forEach(function (p) {
    if (!/^\d+$/.test(p)) return;
    const c = read('/proc/' + p + '/comm', 64);
    if (c && AUDIO_RE.test(c)) procs.push(c.trim());
  });
  r.procs = uniq(procs).sort().slice(0, 40);
  // BMW-SOME/IP-Schnittstellen mit Audio-Bezug (Katalog des Geräts)
  if (opts.someip !== false) {
    const cat = process.env.MGU_SOMEIP_CATALOG || '/etc/oap/someip/someip-interfaces.json';
    let txt = null;
    try { txt = fs.readFileSync(cat, 'utf8'); } catch (e) { r.someipError = e.code || String(e); }
    if (txt) {
      const re = /"(de\.bmw\.[A-Za-z0-9_.]*?(?:[Aa]udio|[Ss]ound|[Gg]ong|[Cc]hime|[Tt]one|ASD|[Aa]coustic|[Vv]olume|[Ss]peaker)[A-Za-z0-9_.]*)"/g;
      const names = [];
      let m;
      while ((m = re.exec(txt)) && names.length < 400) names.push(m[1]);
      r.someip = uniq(names).sort().slice(0, 60);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// SmartX-/ALSA-Erkundung (sinnvoll als root): Wer hält die Soundkarte, welche virtuellen
// Geräte definiert BMW (Intel IAS SmartX), mit welcher ALSA-Konfiguration arbeiten die Audio-Prozesse?
// ---------------------------------------------------------------------------
const AUDIO_PROC_RE = /^(AlsaRoutingAdap|AudioManager|mediaengine|mediaapp|avb_streamhandl|AVBSourceSinkCo|handsfreeaudio|smartx|ias)/i;
const PCM_NAME_RE = /^[ \t]*pcm\.!?"?([A-Za-z0-9_.-]+)"?\s*[{=]/gm;

function probeSmartx() {
  const ls = function (d) { try { return fs.readdirSync(d); } catch (e) { return null; } };
  const read = function (f, n) { try { return fs.readFileSync(f, 'utf8').slice(0, n || 200000); } catch (e) { return null; } };
  const uniq = function (a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); };
  const r = { owners: [], configs: [], pcmNames: [], plugins: [], files: [], shm: [], sockets: [], procs: [], alsaConfigPaths: [], alsaConfigEnv: [] };

  // 1) Wer hält welches PCM-Gerät? (/proc/asound/card0/pcmXp/sub0/status: owner_pid)
  (ls('/proc/asound/card0') || []).filter(function (n) { return /^pcm\d+[pc]$/.test(n); }).forEach(function (n) {
    const st = read('/proc/asound/card0/' + n + '/sub0/status', 2000) || '';
    const hw = read('/proc/asound/card0/' + n + '/sub0/hw_params', 2000) || '';
    const info = read('/proc/asound/card0/' + n + '/info', 2000) || '';
    const pid = (/owner_pid\s*:\s*(\d+)/.exec(st) || [])[1];
    const comm = pid ? (read('/proc/' + pid + '/comm', 64) || '').trim() : '';
    const name = (/^name:\s*(.*)$/m.exec(info) || [])[1] || '';
    const rate = (/^rate:\s*(\d+)/m.exec(hw) || [])[1];
    const fmt = (/^format:\s*(\S+)/m.exec(hw) || [])[1];
    const ch = (/^channels:\s*(\d+)/m.exec(hw) || [])[1];
    r.owners.push(n + (name ? ' "' + name.trim() + '"' : '') + ': ' + (pid ? 'belegt von ' + comm + ' (' + pid + ')' : (/closed/.test(st) ? 'frei' : st.split('\n')[0].trim() || '?')) +
      (rate ? ' ' + rate + ' Hz ' + (fmt || '') + ' ' + (ch || '') + 'ch' : ''));
  });

  // 2) ALSA-Konfiguration und Plugins
  const cfgFiles = ['/etc/asound.conf', '/usr/share/alsa/alsa.conf'];
  ['/usr/share/alsa/alsa.conf.d', '/etc/alsa/conf.d', '/etc/alsa', '/usr/share/alsa/pcm', '/usr/share/alsa/cards'].forEach(function (d) {
    (ls(d) || []).forEach(function (n) { if (/\.conf$/.test(n)) cfgFiles.push(path.join(d, n)); });
  });
  ['/usr/lib/alsa-lib', '/usr/lib64/alsa-lib', '/usr/lib/x86_64-linux-gnu/alsa-lib', '/lib/alsa-lib'].forEach(function (d) {
    (ls(d) || []).forEach(function (n) { r.plugins.push(n.replace(/^libasound_module_/, '').replace(/\.so$/, '')); });
  });

  // 3) Dateien mit SmartX/IAS/Audio-Bezug in /etc, /opt, /usr/share (2 Ebenen), Shared Memory, Sockets
  const FILE_RE = /(smartx|ias[_-]|audio|asound|routing|alsa)/i;
  ['/etc', '/opt', '/usr/share', '/var/opt', '/mnt/dataro/data'].forEach(function (d) {
    (ls(d) || []).forEach(function (n) {
      const p = path.join(d, n);
      if (FILE_RE.test(n)) r.files.push(p);
      if (/^(smartx|ias|audio|alsa)/i.test(n)) (ls(p) || []).slice(0, 30).forEach(function (m) { r.files.push(path.join(p, m)); });
    });
  });
  r.files = uniq(r.files).slice(0, 80);
  r.files.filter(function (f) { return /\.(conf|cfg)$/i.test(f) && /asound|alsa|smartx|ias/i.test(f); }).forEach(function (f) { cfgFiles.push(f); });
  r.shm = (ls('/dev/shm') || []).filter(function (n) { return /(smartx|ias|audio|alsa|pcm|avb|sound)/i.test(n); }).slice(0, 40);
  ['/run', '/tmp', '/var/run', '/run/ias', '/run/smartx', '/tmp/smartx'].forEach(function (d) {
    (ls(d) || []).forEach(function (n) { if (/(smartx|ias|audio|alsa|avb|sound)/i.test(n)) r.sockets.push(path.join(d, n)); });
  });
  r.sockets = uniq(r.sockets).slice(0, 40);

  // 4) Audio-Prozesse: Startbefehl, ALSA-/SmartX-Umgebung, offene Audio-Dateien
  (ls('/proc') || []).forEach(function (pid) {
    if (!/^\d+$/.test(pid)) return;
    const comm = (read('/proc/' + pid + '/comm', 64) || '').trim();
    if (!AUDIO_PROC_RE.test(comm)) return;
    const cmd = (read('/proc/' + pid + '/cmdline', 2000) || '').split('\0').filter(Boolean).join(' ');
    const env = (read('/proc/' + pid + '/environ', 20000) || '').split('\0')
      .filter(function (e) { return /^(ALSA_|SMARTX|IAS|AUDIO|LD_LIBRARY_PATH|AM_)/i.test(e); });
    env.forEach(function (e) {
      const m = /^ALSA_CONFIG_PATH=(.+)$/.exec(e);
      if (m) {
        r.alsaConfigEnv.push(m[1]);
        m[1].split(':').forEach(function (p) { if (p) { r.alsaConfigPaths.push(p); cfgFiles.push(p); } });
      }
    });
    const fds = [];
    (ls('/proc/' + pid + '/fd') || []).forEach(function (fd) {
      let t = null;
      try { t = fs.readlinkSync('/proc/' + pid + '/fd/' + fd); } catch (e) { t = null; }
      if (t && /(\/dev\/snd|\/dev\/shm|smartx|ias|asound|socket:)/.test(t) && !/^socket:/.test(t)) fds.push(t);
    });
    r.procs.push({ pid: pid, comm: comm, cmd: cmd.slice(0, 300), env: env.slice(0, 10), fds: uniq(fds).slice(0, 20) });
  });
  r.alsaConfigPaths = uniq(r.alsaConfigPaths);
  r.alsaConfigEnv = uniq(r.alsaConfigEnv);

  // 5) pcm-Namen aus allen gefundenen Konfigurationen
  const names = [];
  uniq(cfgFiles).forEach(function (f) {
    const txt = read(f);
    if (!txt) return;
    r.configs.push(f);
    let m;
    PCM_NAME_RE.lastIndex = 0;
    while ((m = PCM_NAME_RE.exec(txt)) && names.length < 200) names.push(m[1]);
  });
  r.pcmNames = uniq(names).filter(function (n) { return !/^(front|rear|center_lfe|side|surround\d+|iec958|spdif|modem|phoneline|hdmi|dsnoop|null)$/.test(n); }).slice(0, 60);
  return r;
}

function smartxLines(r) {
  const out = [];
  const add = function (label, val) {
    let s = label + ': ' + val;
    while (s.length > 68) { const cut = s.lastIndexOf(', ', 68); const i = cut > 20 ? cut + 1 : 68; out.push(s.slice(0, i)); s = '   ' + s.slice(i).replace(/^\s+/, ''); }
    out.push(s);
  };
  const list = function (a) { return a && a.length ? a.join(', ') : 'keine'; };
  out.push('--- BMW-Audiosystem (SmartX) ---');
  r.owners.forEach(function (o) { add('PCM', o); });
  add('ALSA-Konfig', list(r.configs));
  add('pcm-Namen', list(r.pcmNames));
  add('ALSA-Plugins', list(r.plugins));
  if (r.alsaConfigPaths.length) add('ALSA_CONFIG_PATH', list(r.alsaConfigPaths));
  add('Shared Memory', list(r.shm));
  add('Sockets', list(r.sockets));
  r.procs.forEach(function (p) {
    add(p.comm + ' (' + p.pid + ')', p.cmd || '-');
    if (p.env.length) add('   Umgebung', list(p.env));
    if (p.fds.length) add('   offen', list(p.fds));
  });
  add('Dateien', list(r.files));
  return out;
}

/** Kurze Textzeilen für die Anzeige (ASCII, max. ~68 Zeichen). */
function diagLines(r, extra) {
  const out = [];
  const add = function (label, val) {
    let s = label + ': ' + val;
    while (s.length > 68) { const cut = s.lastIndexOf(', ', 68); const i = cut > 20 ? cut + 1 : 68; out.push(s.slice(0, i)); s = '   ' + s.slice(i).replace(/^\s+/, ''); }
    out.push(s);
  };
  const list = function (a, none) { return a && a.length ? a.join(', ') : (none || 'keine'); };
  (extra || []).forEach(function (l) { out.push(l); });
  add('Nutzer', r.uid === 0 ? 'root' : 'uid ' + r.uid);
  add('Abspielprogramme', list(r.players));
  add('Python', (r.python || 'nicht gefunden') + (r.alsaScript ? ' · alsa_play.py da' : ' · alsa_play.py fehlt'));
  add('/dev/snd', r.devSnd ? list(r.devSnd) : 'fehlt');
  if (r.devSnd) add('beschreibbar', list(r.devSndWritable));
  if (r.cards) add('Soundkarten', r.cards.split('\n').filter(function (l) { return /^\s*\d+ \[/.test(l); }).map(function (l) { return l.trim(); }).join(' | ') || r.cards.trim().slice(0, 60));
  add('OSS', list(r.oss));
  add('Bibliotheken', list(r.libs));
  add('Programme', list(r.bins));
  add('Prozesse', list(r.procs));
  add('SOME/IP', r.someip ? list(r.someip.map(function (n) { return n.replace(/^de\.bmw\.(infotainment\.|infrastructure\.)?/, ''); })) : 'nicht lesbar (' + (r.someipError || '?') + ')');
  return out;
}

module.exports = {
  probeAudio: probeAudio, diagLines: diagLines, scanAlsa: scanAlsa, findPython: findPython,
  probeSmartx: probeSmartx, smartxLines: smartxLines, usable: usable,
  Engine: Engine, Output: Output, candidates: candidates, toPcm: toPcm, sweepAt: sweepAt,
  RATE: RATE, TICK_MS: TICK_MS, LEAD_MS: LEAD_MS, MAX_CHUNK: MAX_CHUNK
};
