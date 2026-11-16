/*
 * Iconix Sounds – Hauptbildschirm (1600 x 520, Canvas-Empfehlung des idrive7-apps-Kits)
 *
 * Zeichnet über ein kleines Grafik-Interface `g`, damit derselbe Code im Auto (Kit-Canvas)
 * und im PC-Simulator (HTML-Canvas) läuft:
 *   g.rect(x, y, w, h, color)
 *   g.rrect(x, y, w, h, radius, color)
 *   g.text(str, x, baselineY, size, color, align /* 'left'|'center'|'right' *\/, bold)
 *   g.arc(cx, cy, radius, thickness, a0, a1, color)   // Winkel in Radiant, 0 = 3 Uhr, im Uhrzeigersinn
 *
 * Kanonische Quelle: shared/ui.js – Kopie in apps/iconix_sounds/ erzeugt `npm run sync`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IconixUI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 1600, H = 520;
  var C = {
    bg: '#0b0f14', panel: '#151b23', track: '#232b36', text: '#f2f5f8', dim: '#8a96a6',
    accent: '#3d8bfd', accent2: '#7cc4ff', warn: '#ffb020', crit: '#ff4d4d', ok: '#38d27a'
  };
  var A0 = Math.PI * 0.75, A1 = Math.PI * 2.25; // 135° .. 405°

  function pct(x) { return Math.round(x * 100) + ' %'; }

  // Geometrie der bedienbaren Flächen – EINE Quelle für Zeichnen, Touch-Ziele im Auto (cv.target)
  // und Klicks im Simulator.
  var X0 = 600, X1 = 1540, CW = 222, CH = 48, GAP = 12, CHIP_Y = 172;
  var VY = 330, VB = 64;           // Lautstärke-Zeile, Breite der −/+-Knöpfe
  function chipRect(i) {
    return { x: X0 + (i % 4) * (CW + GAP), y: CHIP_Y + Math.floor(i / 4) * (CH + GAP), w: CW, h: CH, r: 12 };
  }
  /** Bedienbare Flächen: [{ key, act, arg, x, y, w, h, r }] – act: 'profile' | 'vol' | 'mute' */
  function hits(profiles) {
    var out = [], i, c;
    for (i = 0; i < profiles.length; i++) {
      c = chipRect(i);
      out.push({ key: 'profile:' + profiles[i].id, act: 'profile', arg: profiles[i].id, x: c.x, y: c.y, w: c.w, h: c.h, r: c.r });
    }
    out.push({ key: 'vol-', act: 'vol', arg: -1, x: X0, y: VY + 4, w: VB, h: 52, r: 14 });
    out.push({ key: 'vol+', act: 'vol', arg: 1, x: X1 - VB, y: VY + 4, w: VB, h: 52, r: 14 });
    out.push({ key: 'mute', act: 'mute', arg: null, x: X1 - 230, y: VY - 40, w: 230, h: 44, r: 10 });
    return out;
  }
  // Diagnose-Ansicht: Weiter / Schließen
  var DIAG_LINES = 11;
  function hitsDiag() {
    return [
      { key: 'diag-devtest', act: 'diagDevTest', arg: null, x: X1 - 760, y: 452, w: 270, h: 52, r: 14 },
      { key: 'diag-next', act: 'diagNext', arg: null, x: X1 - 470, y: 452, w: 220, h: 52, r: 14 },
      { key: 'diag-close', act: 'diagClose', arg: null, x: X1 - 230, y: 452, w: 230, h: 52, r: 14 }
    ];
  }
  function hitAt(profiles, x, y, diag) {
    var h = diag ? hitsDiag() : hits(profiles);
    for (var i = 0; i < h.length; i++) if (x >= h[i].x && x <= h[i].x + h[i].w && y >= h[i].y && y <= h[i].y + h[i].h) return h[i];
    return null;
  }

  /**
   * state = {
   *   profiles: [{id, name}], profile: 'v8',
   *   rpm, redline, speed, load (0..1), volume (0..1),
   *   enabled, sport, pops, demo,
   *   audio: { ok: bool, text: 'aplay · 44,1 kHz' }, hint: '...'
   * }
   */
  function draw(g, s) {
    g.rect(0, 0, W, H, C.bg);

    // ---- Drehzahlring --------------------------------------------------
    var cx = 290, cy = 275, r = 205, th = 24;
    var redline = s.redline || 4800;
    var frac = Math.max(0, Math.min(1, (s.rpm || 0) / (redline * 1.1)));
    var redFrom = redline / (redline * 1.1);
    g.arc(cx, cy, r, th, A0, A1, C.track);
    g.arc(cx, cy, r, th, A0 + (A1 - A0) * redFrom, A1, '#4a2026');
    if (frac > 0.002) {
      var col = frac >= redFrom ? C.crit : (s.sport ? C.warn : C.accent);
      g.arc(cx, cy, r, th, A0, A0 + (A1 - A0) * frac, col);
    }
    g.text(String(Math.round(s.rpm || 0)), cx, cy + 10, 96, C.text, 'center', true);
    g.text('U/min', cx, cy + 58, 30, C.dim, 'center', false);
    g.text(Math.round(s.speed || 0) + ' km/h', cx, cy + 150, 40, C.text, 'center', true);

    var x0 = X0, x1 = X1;
    if (s.diag) { drawDiag(g, s); if (s.hint) g.text(s.hint, cx, 505, 22, C.dim, 'center', false); return; }

    // ---- Profil -------------------------------------------------------
    g.text('ICONIX SOUNDS', x0, 70, 26, C.dim, 'left', true);
    var cur = null, i;
    for (i = 0; i < s.profiles.length; i++) if (s.profiles[i].id === s.profile) cur = s.profiles[i];
    g.text(cur ? cur.name : '–', x0, 140, 62, s.enabled ? C.text : C.dim, 'left', true);

    // Profil-Chips (2 Reihen à 4) – antippbar
    for (i = 0; i < s.profiles.length; i++) {
      var c = chipRect(i);
      var active = s.profiles[i].id === s.profile;
      g.rrect(c.x, c.y, c.w, c.h, c.r, active ? C.accent : C.panel);
      g.text(s.profiles[i].name, c.x + c.w / 2, c.y + 32, s.profiles[i].name.length > 15 ? 16 : 22, active ? '#ffffff' : C.dim, 'center', active);
    }

    // ---- Lautstärke: [−] Balken [+], Antippen von "60 %"/"STUMM" schaltet stumm ----
    var vy = VY;
    g.text('Lautstärke', x0, vy - 8, 28, C.dim, 'left', false);
    g.text(s.enabled ? pct(s.volume) : 'STUMM', x1, vy - 8, 28, s.enabled ? C.text : C.warn, 'right', true);
    g.rrect(x0, vy + 4, VB, 52, 14, C.panel);
    g.text('–', x0 + VB / 2, vy + 42, 40, C.text, 'center', true);
    g.rrect(x1 - VB, vy + 4, VB, 52, 14, C.panel);
    g.text('+', x1 - VB / 2, vy + 42, 40, C.text, 'center', true);
    var bx = x0 + VB + 16, bw = x1 - x0 - 2 * (VB + 16);
    g.rrect(bx, vy + 17, bw, 26, 13, C.track);
    var vw = bw * Math.max(0, Math.min(1, s.volume));
    if (vw > 26) g.rrect(bx, vy + 17, vw, 26, 13, s.enabled ? C.accent2 : C.dim);

    // ---- Last ---------------------------------------------------------
    var ly = 432;
    g.text('Last', x0, ly, 24, C.dim, 'left', false);
    g.rrect(x0 + 80, ly - 18, x1 - x0 - 80, 14, 7, C.track);
    var lw = (x1 - x0 - 80) * Math.max(0, Math.min(1, s.load || 0));
    if (lw > 14) g.rrect(x0 + 80, ly - 18, lw, 14, 7, C.ok);

    // ---- Status -------------------------------------------------------
    var sy = 490;
    var a = s.audio || { ok: false, text: 'Audio-Dienst nicht verbunden' };
    g.rrect(x0, sy - 20, 20, 20, 10, a.ok ? C.ok : C.crit);
    g.text(a.text, x0 + 32, sy - 2, 24, C.dim, 'left', false);
    var tags = [];
    if (s.demo) tags.push(['DEMO', C.warn]);
    if (s.sport) tags.push(['SPORT', C.warn]);
    if (s.pops) tags.push(['POPS', C.accent2]);
    var tx = x1;
    for (i = tags.length - 1; i >= 0; i--) {
      var tw = tags[i][0].length * 15 + 28;
      tx -= tw;
      g.rrect(tx, sy - 30, tw, 36, 10, C.panel);
      g.text(tags[i][0], tx + tw / 2, sy - 3, 22, tags[i][1], 'center', true);
      tx -= 10;
    }
    if (s.hint) g.text(s.hint, cx, 505, 22, C.dim, 'center', false);
  }

  // s.diag = { lines: [...], page: 0 }
  function drawDiag(g, s) {
    var d = s.diag, pages = Math.max(1, Math.ceil(d.lines.length / DIAG_LINES));
    var page = ((d.page || 0) % pages + pages) % pages;
    g.rrect(X0 - 20, 30, X1 - X0 + 40, 480, 18, C.panel);
    g.text('AUDIO-DIAGNOSE', X0, 70, 26, C.accent2, 'left', true);
    g.text('Seite ' + (page + 1) + '/' + pages, X1, 70, 22, C.dim, 'right', false);
    var ls = d.lines.slice(page * DIAG_LINES, page * DIAG_LINES + DIAG_LINES);
    // Zeilen kürzen, damit sie nicht in die Knöpfe/den Rand laufen
    ls = ls.map(function (l) { return l.length > 74 ? l.slice(0, 73) + '…' : l; });
    for (var i = 0; i < ls.length; i++) g.text(ls[i], X0, 110 + i * 28, 22, i === 0 && page === 0 ? C.text : C.dim, 'left', false);
    var b = hitsDiag();
    g.rrect(b[0].x, b[0].y, b[0].w, b[0].h, b[0].r, C.track);
    g.text('Geraete testen', b[0].x + b[0].w / 2, b[0].y + 35, 24, C.warn, 'center', true);
    g.rrect(b[1].x, b[1].y, b[1].w, b[1].h, b[1].r, C.track);
    g.text('Weiter', b[1].x + b[1].w / 2, b[1].y + 35, 24, C.text, 'center', true);
    g.rrect(b[2].x, b[2].y, b[2].w, b[2].h, b[2].r, C.accent);
    g.text('Schliessen', b[2].x + b[2].w / 2, b[2].y + 35, 24, '#ffffff', 'center', true);
    // Status (z. B. laufender Gerätetest) unten links
    if (s.audio && s.audio.text) g.text(s.audio.text.length > 74 ? s.audio.text.slice(0, 73) + '…' : s.audio.text, X0, 440, 22, s.audio.ok ? C.ok : C.warn, 'left', true);
  }

  return { W: W, H: H, colors: C, draw: draw, hits: hits, hitsDiag: hitsDiag, hitAt: hitAt, DIAG_LINES: DIAG_LINES };
});
