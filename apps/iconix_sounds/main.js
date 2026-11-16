'use strict';
/*
 * Iconix Sounds – App für den mgu-store (Format: idrive7-apps-Kit, mgu.run)
 *
 * Aufgaben der App:
 *   - Fahrzeugdaten lesen (vehicle_feed.js) und an den Audio-Daemon schicken (audio_link.js)
 *   - Bildschirm zeichnen (ui.js – identisch zum PC-Simulator)
 *   - Bedienung: iDrive drehen = Lautstärke, drücken = nächster Sound, Buttons, Einstellungen
 *
 * Der Ton selbst entsteht im Tool "iconix-audiod" (Root-Dienst), weil Store-Apps keine
 * Audio-Schnittstelle haben.
 *
 * Die Kit-Aufrufe sind gegen idrive7-apps (kit/runtime/mgu.js, record.js, display.js, signals.js,
 * apps/redline/main.js) abgeglichen.
 */
const mgu = require('./kit/mgu');
const Profiles = require('./profiles');
const UI = require('./ui');
const AudioLink = require('./audio_link');
const VehicleFeed = require('./vehicle_feed');

const VERSION = '0.5.2-b57';
const DEFAULTS = {
  enabled: true, profile: Profiles.DEFAULT, volume: 60, intensity: 70, pops: false, sport: false,
  muteParked: false, dialVolume: true, loadSource: 'auto', alsaDevice: 'auto', maxTorque: 400, carIdle: 800, carRedline: 4800
};

function setting(settings, key) {
  let v;
  try { v = settings && settings.get ? settings.get(key) : undefined; } catch (e) { v = undefined; }
  return v === undefined || v === null ? DEFAULTS[key] : v;
}
function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
function bool(v) { return v === true || v === 'true' || v === 1 || v === '1'; }

// ---------------------------------------------------------------------------
// Kern: Fahrzeugdaten -> Audio-Daemon. Läuft einmal pro Prozess, im Vordergrund
// und (mit "autostart") im Hintergrund, damit der Sound auch ohne offene App spielt.
// ---------------------------------------------------------------------------
let core = null;

function startCore(host) {
  if (core) return core;
  const log = host.log || console;
  const settings = host.settings;

  // Einstellungen werden nur bei Änderungen gelesen und dann zwischengespeichert –
  // nicht in jedem Frame bzw. bei jedem Drehzahl-Update.
  let parkedMute = false;
  let last = null;
  let feedCfg = null, synthCfgCache = null, uiCfg = null;

  const refresh = () => {
    const g = k => setting(settings, k);
    feedCfg = {
      loadSource: String(g('loadSource')),
      maxTorque: num(g('maxTorque'), 400),
      carIdle: num(g('carIdle'), 800)
    };
    synthCfgCache = {
      enabled: bool(g('enabled')) && !parkedMute,
      profile: Profiles.ids.indexOf(String(g('profile'))) >= 0 ? String(g('profile')) : Profiles.DEFAULT,
      volume: num(g('volume'), 60) / 100,
      intensity: num(g('intensity'), 70) / 100,
      pops: bool(g('pops')),
      sport: bool(g('sport')),
      carIdle: feedCfg.carIdle,
      carRedline: num(g('carRedline'), 4800),
      device: String(g('alsaDevice') || 'auto')
    };
    uiCfg = { muteParked: bool(g('muteParked')), dialVolume: bool(g('dialVolume')) };
  };
  refresh();

  const link = new AudioLink(log, VERSION);
  const feed = new VehicleFeed(host.signals, log, () => feedCfg);
  const synthCfg = () => synthCfgCache;
  const pushCfg = () => { refresh(); link.configure(synthCfgCache); };

  feed.on('sample', s => {
    last = s;
    link.params(s);
    const shouldMute = uiCfg.muteParked && s.speed < 0.5;
    if (shouldMute !== parkedMute) { parkedMute = shouldMute; pushCfg(); }
  });

  pushCfg();
  link.connect();
  feed.start();
  log.info('iconix: Kern gestartet, Version ' + VERSION);

  core = { link, feed, pushCfg, synthCfg, ui: () => uiCfg, log, last: () => last };
  return core;
}

// ---------------------------------------------------------------------------
// Grafik-Adapter: ui.js -> Kit-Recorder (kit/runtime/record.js, geprüft gegen idrive7-apps)
//   fillRect(x, y, w, h, c) · roundRect(x, y, w, h, r, c) · text(str, x, baselineY, size, c, {font, align, literal})
//   arc(cx, cy, r0, r1, a0, a1, c, opts): Winkel in GRAD, im Uhrzeigersinn ab 12 Uhr
//   Farben: '#rrggbb' (canvas.js rgba)
// Die Schriften des Kits (label/bold/light) enthalten keine Umlaute -> ä/ö/ü/ß werden umschrieben.
// ---------------------------------------------------------------------------
const UMLAUT = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss', '„': '"', '“': '"', '”': '"' };
const textCache = new Map();
function kitText(s) {
  s = String(s);
  let v = textCache.get(s);
  if (v === undefined) {
    v = s.replace(/[äöüÄÖÜß„“”]/g, ch => UMLAUT[ch]);
    if (textCache.size > 500) textCache.clear();
    textCache.set(s, v);
  }
  return v;
}
const RAD2DEG = 180 / Math.PI;
function kitGfx(c) {
  return {
    rect: (x, y, w, h, col) => c.fillRect(x, y, w, h, col),
    rrect: (x, y, w, h, r, col) => c.roundRect(x, y, w, h, r, col),
    text: (s, x, y, size, col, align, bold) => c.text(kitText(s), x, y, size, col, { align: align || 'left', font: bold ? 'bold' : 'label', literal: true }),
    arc: (cx, cy, r, th, a0, a1, col) => {
      // ui.js: Radiant ab 3 Uhr -> Kit: Grad ab 12 Uhr; über 360° hinaus in zwei Stücke teilen
      let d0 = a0 * RAD2DEG + 90, d1 = a1 * RAD2DEG + 90;
      while (d0 >= 360) { d0 -= 360; d1 -= 360; }
      if (d1 <= 360) c.arc(cx, cy, r - th, r, d0, d1, col);
      else { c.arc(cx, cy, r - th, r, d0, 360, col); c.arc(cx, cy, r - th, r, 0, d1 - 360, col); }
    }
  };
}

// ---------------------------------------------------------------------------
// iDrive-Controller: ctx.controller.onInput liefert die Felder von FrontCCU.statusRotaryEncoderState
// (Enums als Zahlen). Auswertung wie im Kit (kit/runtime/display.js _ccu):
//   frontRotaryEncoderOperation  16-Bit-Zähler (Drehung = Differenz, |d| > 64 = Zähler-Reset)
//   frontRotaryEncoderPushButton 1/2 = gedrückt (nur die Flanke zählt), 15 + Deflection 15 = kein Controller
// Die ersten 20 Ereignisse werden geloggt (data/iconix_sounds.log).
// ---------------------------------------------------------------------------
function makeInputDecoder(log) {
  let last = null, logged = 0;
  const down = x => x === 1 || x === 2;
  return function decode(ev) {
    if (logged < 20) { logged++; try { log.info('iconix: input ' + JSON.stringify(ev)); } catch (e) { /* egal */ } }
    if (!ev || typeof ev !== 'object') return { rotate: 0, press: false };
    const k = Number(ev.frontRotaryEncoderOperation), pb = Number(ev.frontRotaryEncoderPushButton), df = Number(ev.frontRotaryEncoderDeflection);
    if (pb === 15 && df === 15) return { rotate: 0, press: false }; // kein Controller dahinter
    let rotate = 0;
    if (last && isFinite(k) && isFinite(last.k)) {
      rotate = ((k - last.k + 32768) & 0xffff) - 32768;
      if (rotate > 64 || rotate < -64) rotate = 0; // Zähler-Reset
    }
    const press = down(pb) && !(last && down(last.pb));
    last = { k, pb };
    return { rotate: Math.max(-5, Math.min(5, rotate)), press };
  };
}

mgu.run({
  async start(ctx) {
    const c = startCore(ctx);
    const log = ctx.log || console;
    const get = k => setting(ctx.settings, k);
    const set = (k, v) => {
      try { ctx.settings.set(k, v); } catch (e) { log.warn('iconix: settings.set ' + k + ': ' + e.message); }
      c.pushCfg();
    };

    if (ctx.settings && ctx.settings.onChange) ctx.settings.onChange(() => c.pushCfg());

    const nextProfile = () => set('profile', Profiles.next(String(get('profile')), 1));
    const changeVolume = steps => {
      const v = Math.max(0, Math.min(100, Math.round((num(get('volume'), 60) + steps * 5) / 5) * 5));
      set('volume', v);
    };

    // Buttons aus app.json
    ctx.ui.onClick('BTN_PROFILE', nextProfile);
    ctx.ui.onClick('BTN_MUTE', () => set('enabled', !bool(get('enabled'))));
    ctx.ui.onClick('BTN_TEST', () => c.link.test());
    // Audio-Diagnose: zeigt, welche Tonwege es auf diesem Head Unit gibt (an-/ausschalten)
    let diag = null;
    const openDiag = () => { diag = { lines: c.link.diagnose(), page: 0 }; };
    ctx.ui.onClick('BTN_DIAG', () => { if (diag) diag = null; else openDiag(); });
    // Antwort des Dienstes (root) nachreichen
    c.link.on('diag', () => { if (diag) diag.lines = c.link.diagnose(false); });

    // Bedienbare Flächen (Profil-Chips, Lautstärke −/+, Stumm) – Geometrie aus ui.js
    const act = h => {
      if (h.act === 'profile') set('profile', h.arg);
      else if (h.act === 'vol') changeVolume(h.arg);
      else if (h.act === 'mute') set('enabled', !bool(get('enabled')));
      else if (h.act === 'diagNext' && diag) diag.page++;
      else if (h.act === 'diagClose') diag = null;
      else if (h.act === 'diagDevTest') c.link.testDevices();
    };
    const HITS_DIAG = UI.hitsDiag().map(h => Object.assign({ run: () => act(h) }, h));
    const HITS = UI.hits(Profiles.list).map(h => Object.assign({ run: () => act(h) }, h));

    // Zwei Betriebsarten des Kits (kit/runtime/display.js):
    //  - "Kit führt den Bildschirm" (cv.own: GPU-Renderer mit Touch-Weiterleitung): Touch und der iDrive-Knopf
    //    gehen über die Ziele aus cv.target(...) – Drehen wandert über Chips/Knöpfe/Leiste, Drücken löst aus.
    //    ctx.controller.onInput bekommt dann nichts (das Kit wertet den Knopf selbst aus).
    //  - sonst: kein Touch auf der Seite möglich; der Knopf kommt per grab/onInput (Drehen = Lautstärke).
    const decode = makeInputDecoder(log);
    let grabbed = false, visible = false, own = false;
    const grab = on => {
      if (!ctx.controller || grabbed === on) return;
      try { ctx.controller.grab(on); grabbed = on; } catch (e) { log.warn('iconix: grab: ' + e.message); }
    };
    const updateGrab = () => grab(visible && !own && c.ui().dialVolume);
    if (ctx.controller && ctx.controller.onInput) {
      ctx.controller.onInput(ev => {
        const i = decode(ev);
        if (i.rotate) changeVolume(i.rotate);
        if (i.press) nextProfile();
      });
    }
    if (ctx.ui.onVisible) {
      ctx.ui.onVisible((name, v) => { if (name === 'MAIN') { visible = v; updateGrab(); } });
    }
    // Rückfall: Tippen ohne Ziel (falls ein Kit-Stand Taps nur über onTap liefert)
    if (ctx.onTap) {
      ctx.onTap((x, y) => { const h = UI.hitAt(Profiles.list, x, y, !!diag); if (h) act(h); });
    }

    // Bildschirm (wie apps/redline/main.js): pro Frame ctx.canvas(W, H) holen – das Kit gibt denselben,
    // zurückgesetzten Recorder zurück – und an das Grafik-Widget "<SCREEN>_GFX" übergeben.
    // Mit GPU-Renderer ruft das Kit die Schleife bis zu 60x/s; ein Frame ohne Änderung wird nicht gesendet.
    // Ohne Renderer (PNG-Weg) gilt die angefragte Rate: 20 fps reichen für die Drehzahlanzeige.
    // Das Zustandsobjekt wird wiederverwendet (keine Allokation pro Frame).
    const HINT_DIAL = 'Drehen: Lautstärke · Drücken: Sound wechseln';
    const HINT_TOUCH = 'Antippen oder iDrive: Sound und Lautstärke wählen';
    const st = { profiles: Profiles.list };
    ctx.loop('MAIN', 20, () => {
      const cv = ctx.canvas(UI.W, UI.H);
      const g = kitGfx(cv);
      visible = true;
      if (!!cv.own !== own) { own = !!cv.own; log.info('iconix: Kit führt den Bildschirm: ' + own); }
      updateGrab();
      const s = c.last();
      const cfg = c.synthCfg();
      st.profile = cfg.profile;
      st.rpm = s ? s.rpm : 0; st.speed = s ? s.speed : 0; st.load = s ? s.load : 0;
      st.redline = cfg.carRedline; st.volume = cfg.volume; st.enabled = cfg.enabled;
      st.sport = cfg.sport; st.pops = cfg.pops; st.demo = !s;
      st.audio = c.link.status;
      st.hint = own ? HINT_TOUCH : (c.ui().dialVolume ? HINT_DIAL : '');
      st.diag = diag;
      UI.draw(g, st);
      // Ziele nach dem Zeichnen registrieren (wie apps/dyno, live_data: nur wenn cv.own)
      if (own && typeof cv.target === 'function') {
        const list = diag ? HITS_DIAG : HITS;
        for (let i = 0; i < list.length; i++) { const h = list[i]; cv.target(h.x, h.y, h.w, h.h, h.run, h.key, h.r); }
      }
      return ctx.ui.image('MAIN_GFX', cv);
    });

    log.info('iconix: Vordergrund gestartet');
  },

  // Hintergrund (app.json "autostart": true): Sound auch ohne geöffnete App.
  // Laut kit/runtime/mgu.js: bg = { app, log, settings, signals, spec, dataDir }; läuft vor start(ctx).
  background(bg) {
    if (bg && bg.signals) startCore(bg);
    else if (bg && bg.log) bg.log.warn('iconix: background ohne signals – Sound nur bei geöffneter App');
    return null;
  }
});
