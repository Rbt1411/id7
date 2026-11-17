'use strict';
/*
 * Iconix Sounds – Tonausgabe aus Sicht der App
 *
 * 1. Bevorzugt: Audio-Dienst (Tool iconix-audiod, läuft als root) über einen Unix-Socket.
 *    Es werden mehrere Pfade probiert: /run/iconix-audiod/audiod.sock, /tmp/iconix-audiod.sock.
 * 2. Rückfall: ist der Dienst nach FALLBACK_MS nicht erreichbar, erzeugt die App den Ton selbst
 *    (engine.js: Synthese + aplay/pacat/...). Ob die App als normaler Nutzer das Audiogerät öffnen darf,
 *    zeigt die Statuszeile. Verbindet sich der Dienst später, übernimmt er wieder.
 *
 * Protokoll zum Dienst: eine JSON-Nachricht pro Zeile.
 *   App -> Dienst: hello, config {cfg}, params {rpm, load, speed, overrun}, test
 *   Dienst -> App: status {ok, backend, rate, playing, error, underruns, late, ...}
 * Zusätzlich schreibt der Dienst /tmp/iconix-audiod.json – daran erkennt die App, ob er überhaupt läuft.
 */
const fs = require('fs');
const net = require('net');
const EventEmitter = require('events');

const SOCKETS = process.env.ICONIX_AUDIOD_SOCKET
  ? [process.env.ICONIX_AUDIOD_SOCKET]
  : ['/run/iconix-audiod/audiod.sock', '/tmp/iconix-audiod.sock'];
const STATUS_FILE = process.env.ICONIX_STATUS_FILE || '/tmp/iconix-audiod.json';
const RECONNECT_MS = 2000;
const SEND_MS = 50;       // 20 Hz Parameter-Updates
const STALE_MS = 1500;    // ältere Fahrzeugdaten nicht senden -> Ton blendet aus
const FALLBACK_MS = Number(process.env.ICONIX_FALLBACK_MS) || 5000;

function khz(rate) { return String((rate || 44100) / 1000).replace('.', ','); }

class AudioLink extends EventEmitter {
  /**
   * @param log         ctx.log
   * @param appVersion  Version für die Begrüßung
   * @param opts        { fallback: true }  – Ton aus der App, wenn der Dienst fehlt
   */
  constructor(log, appVersion, opts) {
    super();
    this.log = log;
    this.version = appVersion || '0';
    this.fallback = !opts || opts.fallback !== false;
    this.sock = null;
    this.connected = false;
    this.rx = '';
    this.cfg = null;
    this.latest = null;
    this.timer = null;
    this.reconnectTimer = null;
    this.closed = false;
    this.pathIndex = 0;
    this.errors = {};        // Pfad -> letzter Fehlercode (ENOENT, EACCES, ECONNREFUSED, ...)
    this.startedAt = Date.now();
    this.local = null;       // Engine im App-Prozess (Rückfall)
    this.localStatus = null;
    this.daemonStatus = null;
    this.status = { ok: false, text: 'Audio: verbinde …' };
  }

  connect() {
    if (this.closed || this.sock) return;
    if (!this.timer) this.timer = setInterval(() => this._tick(), SEND_MS);
    const p = SOCKETS[this.pathIndex % SOCKETS.length];
    const s = net.createConnection(p);
    this.sock = s;
    s.setEncoding('utf8');
    s.on('connect', () => {
      this.connected = true;
      this.errors = {};
      this.log.info('iconix: Audio-Dienst verbunden über ' + p);
      this._stopLocal('Audio-Dienst verbunden');
      this.send({ op: 'hello', id: 'iconix_sounds', version: this.version });
      if (this.cfg) this.send({ op: 'config', cfg: this.cfg });
      this._update();
    });
    s.on('data', chunk => {
      this.rx += chunk;
      let i;
      while ((i = this.rx.indexOf('\n')) >= 0) {
        const line = this.rx.slice(0, i);
        this.rx = this.rx.slice(i + 1);
        if (line) this._onMessage(line);
      }
      if (this.rx.length > 65536) this.rx = '';
    });
    s.on('error', e => { this.errors[p] = (e && e.code) || String(e); });
    s.on('close', () => {
      const was = this.connected;
      this.sock = null;
      this.connected = false;
      if (was) { this.daemonStatus = null; this.log.warn('iconix: Verbindung zum Audio-Dienst verloren'); }
      else this.pathIndex++; // nächsten Pfad probieren
      this._update();
      if (!this.closed && !this.reconnectTimer) {
        // alle Pfade einmal durch, dann Pause
        const delay = (!was && this.pathIndex % SOCKETS.length !== 0) ? 50 : RECONNECT_MS;
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
      }
    });
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sock) this.sock.destroy();
    this._stopLocal();
  }

  send(obj) {
    if (!this.sock || !this.connected) return false;
    try { this.sock.write(JSON.stringify(obj) + '\n'); return true; } catch (e) { return false; }
  }

  configure(cfg) {
    this.cfg = cfg;
    if (cfg.device === 'smartx' && this.local) this._stopLocal('SmartX erfordert Audio-Dienst');
    this.send({ op: 'config', cfg: cfg });
    if (this.local) this.local.configure(cfg);
  }

  route(granted) { return this.send({ op: 'route', granted: granted === true }); }
  stopTest() { return this.send({ op: 'stoptest' }); }

  params(sample) { this.latest = sample; }

  /** Testsound nacheinander auf allen ALSA-Geräten, die der Dienst öffnen kann (je 4 s). */
  testDevices() {
    if (this.connected) return this.send({ op: 'testdevices' });
    if (this.local) { this.local.testDevices(); return true; }
    return false;
  }

  test() {
    if (this.connected) return this.send({ op: 'test' });
    if (!this.local && this.fallback) this._startLocal();
    if (this.local) { this.local.test(); return true; }
    return false;
  }

  /**
   * Audio-Diagnose als Textzeilen: Sicht der App (ohne Root) und – falls verbunden – des Dienstes (root).
   * Die Antwort des Dienstes kommt asynchron und wird bei erneutem Aufruf angehängt.
   */
  diagnose(ask) {
    let E;
    try { E = require('./engine'); } catch (e) { return ['engine.js fehlt: ' + e.message]; }
    const head = ['Status: ' + this.status.text, 'Dienst: ' + (this.connected ? 'verbunden' : this._why())];
    const ds = this.daemonStatus;
    if (this.connected && ds) {
      head.push('Ausgabegerät: ' + (ds.device || 'auto') + ' · Python: ' + (ds.python || 'nicht gefunden'));
      if (ds.scan) {
        let n = 0;
        head.push('ALSA-Geräte (Nummer = Einstellung "Gerät N"):');
        ds.scan.forEach(x => head.push(x.ok ? '  ' + (++n) + ') ' + x.name + ' – lässt sich öffnen'
          : x.silent ? '  -  ' + x.name + ' – stumm (verwirft den Ton)'
          : '  -  ' + x.name + ' – ' + String(x.error || 'Fehler').replace(/^(open|set_params): /, '')));
        if (!n) head.push('  (kein hörbares Gerät frei – Details zum BMW-Audiosystem folgen)');
      } else head.push('ALSA-Scan: ' + (ds.scanError || 'läuft noch …'));
      head.push('"Geräte testen" spielt den Testsound auf jedem Gerät 1), 2), ... je 4 s');
    }
    // zuerst die Sicht des Dienstes (root, wichtiger), danach die der App
    let lines = head.slice();
    if (this.connected) {
      if (ask !== false) this.send({ op: 'diag' });
      lines = lines.concat(this.daemonDiag || ['(Dienst wird abgefragt ...)']);
    }
    let r;
    try { r = E.probeAudio({ someip: !this.connected }); } catch (e) { return lines.concat(['Diagnose (App) fehlgeschlagen: ' + e.message]); }
    try { this.log.info('iconix: Audio-Diagnose (App) ' + JSON.stringify(r)); } catch (e) { /* egal */ }
    return lines.concat(E.diagLines(r, ['--- Sicht der App ---']));
  }

  _tick() {
    const p = this.latest;
    const now = Date.now();
    // Rückfall starten, wenn der Dienst zu lange fehlt
    if (!this.connected && !this.local && this.fallback && !(this.cfg && this.cfg.device === 'smartx') && now - this.startedAt > FALLBACK_MS) this._startLocal();
    if (!p || now - p.at > STALE_MS) return;
    const rpm = Math.round(p.rpm), load = Math.round(p.load * 1000) / 1000, speed = Math.round(p.speed * 10) / 10;
    const msg = { op: 'params', rpm: rpm, load: load, speed: speed, overrun: p.overrun };
    if (this.local) { this.local.params(msg); return; }
    // gerundet senden und Unverändertes nur als Keepalive alle 500 ms
    const key = rpm + '|' + load + '|' + speed + '|' + (p.overrun ? 1 : 0);
    if (key === this.lastKey && now - this.lastSend < 500) return;
    this.lastKey = key; this.lastSend = now;
    this.send(msg);
  }

  _startLocal() {
    let Engine;
    try { Engine = require('./engine').Engine; } catch (e) {
      this.localStatus = { error: 'Ton in der App nicht möglich: ' + e.message };
      this.fallback = false; this._update();
      return;
    }
    this.log.warn('iconix: Audio-Dienst nicht erreichbar (' + this._why() + ') – erzeuge den Ton in der App');
    this.local = new Engine({
      log: m => this.log.info('iconix-engine: ' + m),
      onStatus: st => { this.localStatus = st; this._update(); }
    });
    if (this.cfg) this.local.configure(this.cfg);
    this.local.start();
    this.localStatus = this.local.status();
    this._update();
  }

  _stopLocal(reason) {
    if (!this.local) return;
    this.log.info('iconix: Ton aus der App beendet (' + (reason || 'Ende') + ')');
    try { this.local.stop(); } catch (e) { /* egal */ }
    this.local = null;
    this.localStatus = null;
  }

  // Warum ist der Dienst nicht erreichbar? (für Log und Statuszeile)
  _why() {
    const codes = SOCKETS.map(p => this.errors[p]).filter(Boolean);
    if (codes.indexOf('EACCES') >= 0 || codes.indexOf('EPERM') >= 0) return 'kein Zugriff auf den Socket';
    let running = false;
    try {
      const st = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
      running = st && Date.now() - (st.at || 0) < 10000;
    } catch (e) { running = false; }
    if (running) return 'Dienst läuft, Socket nicht erreichbar (' + (codes[0] || '?') + ')';
    if (codes.length && codes.every(c => c === 'ENOENT')) return 'Dienst läuft nicht – Tool "Iconix Audio" installiert?';
    return codes[0] || 'unbekannt';
  }

  _onMessage(line) {
    let m;
    try { m = JSON.parse(line); } catch (e) { return; }
    if (m.op === 'diag' && Array.isArray(m.lines)) { this.daemonDiag = m.lines; this.emit('diag', m.lines); return; }
    if (m.op !== 'status') return;
    this.daemonStatus = m;
    this._update();
  }

  _describe(m, prefix) {
    if (m.devTest) return { ok: true, text: 'Gerätetest ' + m.devTest.i + '/' + m.devTest.n + ': ' + m.devTest.device + ' – hörst du etwas?' };
    if (m.device === 'smartx' && m.smartxRoute === false) return { ok: false, text: 'SmartX: wartet auf AudioManager-Verbindung' };
    if (m.error) return { ok: false, text: prefix + m.error };
    let text = prefix + (m.backend || '?') + ' · ' + khz(m.rate) + ' kHz' + (m.playing ? ' · spielt' : ' · bereit');
    // Aussetzer (Underruns des Abspielprogramms + verspätete Wakeups) sichtbar machen
    const drops = (m.underruns || 0) + (m.late || 0);
    if (drops > 0) text += ' · ' + drops + ' Aussetzer';
    return { ok: !!m.backend, text: text };
  }

  _update() {
    let st;
    if (this.connected) st = this.daemonStatus ? this._describe(this.daemonStatus, 'Audio: ') : { ok: true, text: 'Audio-Dienst verbunden' };
    else if (this.local && this.localStatus) st = this._describe(this.localStatus, 'Audio (App): ');
    else if (this.localStatus && this.localStatus.error) st = { ok: false, text: this.localStatus.error };
    else if (Date.now() - this.startedAt < FALLBACK_MS) st = { ok: false, text: 'Audio: verbinde …' };
    else st = { ok: false, text: 'Audio-Dienst: ' + this._why() };
    st.mode = this.connected ? 'daemon' : (this.local ? 'app' : 'none');
    if (st.text !== this.status.text || st.ok !== this.status.ok) {
      this.status = st;
      this.emit('status', st);
    }
  }
}

module.exports = AudioLink;
module.exports.SOCKETS = SOCKETS;
