/*
 * Iconix Sounds – prozedurale Motor-/Elektro-Sound-Synthese
 *
 * Läuft identisch im Audio-Daemon auf dem Head Unit (Node 8) und im PC-Simulator (Browser).
 * Kanonische Quelle: shared/synth.js – Kopien erzeugt `npm run sync`.
 *
 *   var s = new IconixSynth(44100);
 *   s.configure({ profile: 'v8', volume: 0.7 });
 *   s.setParams({ rpm: 2500, load: 0.6, speed: 80, overrun: false });
 *   s.render(float32InterleavedStereo, frames);
 *
 * Performance (wichtig für das Head Unit):
 *   - Sinus über eine Tabelle mit linearer Interpolation statt Math.sin pro Oberton und Sample
 *   - Steuergrößen (Frequenzen, Filter, Pegel, Glättung) nur alle CR = 32 Samples ("control rate"),
 *     die Lautstärke wird dazwischen linear interpoliert (keine Zipper-Geräusche)
 *   - Audio-Schleifen arbeiten mit lokalen Variablen und typisierten Arrays, ohne Allokationen
 *   - bei Stille wird gar nicht gerechnet
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./profiles'), require('./b57_samples'));
  else root.IconixSynth = factory(root.IconixProfiles, null);
})(typeof self !== 'undefined' ? self : this, function (Profiles, B57Samples) {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var HEADROOM = 0.62;     // Reserve, damit 100 % + Sport-Boost nicht hart clippt
  var CR = 32;             // Control-Rate: Steuergrößen alle 32 Samples (~0,7 ms)
  var MAXH = 16;           // max. Obertöne / Stimmen pro Profil
  var TN = 4096;           // Sinus-Tabellengröße
  var INV32 = 1 / 4294967296;

  // Sinustabelle mit Schutzwert am Ende (für die Interpolation)
  var SIN = new Float32Array(TN + 1);
  for (var t = 0; t <= TN; t++) SIN[t] = Math.sin(TWO_PI * t / TN);

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function finite(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }

  // Profil für die schnelle Verarbeitung vorbereiten (einmal je Profil)
  function prepare(p) {
    if (p._prep) return p._prep;
    var list = p.kind === 'electric' ? p.voices : (p.harmonics || []);
    var n = Math.min(list.length, MAXH), ord = new Float64Array(n), amp = new Float64Array(n), det = new Float64Array(n);
    var sum = 0, i;
    for (i = 0; i < n; i++) { ord[i] = list[i][0]; amp[i] = list[i][1]; det[i] = list[i][2] || 0; sum += amp[i]; }
    if (p.kind === 'electric') sum += p.sub || 0;
    p._prep = { n: n, ord: ord, amp: amp, det: det, norm: sum > 0 ? 1 / sum : 1 };
    return p._prep;
  }

  function Synth(sampleRate) {
    this.sr = sampleRate || 44100;
    this.cfg = {
      enabled: true,
      profile: Profiles.DEFAULT,
      volume: 0.6,      // 0..1
      intensity: 0.7,   // 0..1 Ausprägung (Lastabhängigkeit des Klangs)
      pops: false,      // Patscher im Schubbetrieb
      sport: false,     // +30 % Pegel
      carIdle: 800,     // echte Leerlaufdrehzahl des Autos
      carRedline: 4800  // echte Drehzahl, die "maxRpm" des Profils entspricht
    };
    this.target = { rpm: 800, load: 0, speed: 0, overrun: false };
    this.stale = false;
    this.pending = null;
    this.rpm = 800; this.load = 0; this.speed = 0;
    this.gain = 0; this.vol = 0; this.amp = 0; this.ampStep = 0;
    this.seed = 0x2545F491;
    this.bov = 0; this.pop = 0; this.popPhase = 0; this.lfoPhase = 0;
    this.cnt = 0;

    // Glättungskoeffizienten pro Control-Schritt
    var sr = this.sr;
    function k(sec) { return 1 - Math.exp(-CR / (sr * sec)); }
    this.kR = k(0.04); this.kL = k(0.08); this.kS = k(0.2); this.kG = k(0.12); this.kV = k(0.1);
    this.bovDecay = Math.exp(-1 / (sr * 0.25));
    this.popDecay = Math.exp(-1 / (sr * 0.035));
    this.popInc = 70 / sr;

    // Steuergrößen (von _control berechnet, von den Audio-Schleifen gelesen)
    this.inc = new Float64Array(MAXH);
    this.w = new Float64Array(MAXH);
    this.nActive = 0;
    this.fireInc = 0; this.fq = 0.1; this.level = 0; this.nk = 0.1; this.noiseAmt = 0; this.roughAmt = 0;
    this.turboInc = 0; this.turboAmt = 0; this.subInc = 0; this.subW = 0;

    this._setProfile(this.cfg.profile);
    this._reset();
  }

  Synth.prototype._setProfile = function (id) {
    this.profile = Profiles.get(id);
    // Shorter control smoothing only for the recording-based profile.
    this.kR = 1 - Math.exp(-CR / (this.sr * (this.profile.kind === "sample" ? 0.018 : 0.04)));
    this.kL = 1 - Math.exp(-CR / (this.sr * (this.profile.kind === "sample" ? 0.025 : 0.08)));
    this.cfg.profile = this.profile.id;
    this.prep = prepare(this.profile);
    if (this.profile.kind === 'sample' && B57Samples && !this.b57) this.b57 = new B57Samples(this.sr);
    var d = this.profile.drive || 1;
    this.drive = d;
    this.driveNorm = (1 + d) / d;
  };

  Synth.prototype._reset = function () {
    this.phases = new Float64Array(MAXH);
    this.firePhase = 0; this.rough = 1; this.roughTarget = 1;
    this.noiseLp = 0; this.noiseLp2 = 0;
    this.low = 0; this.band = 0;
    this.turboPhase = 0; this.subPhase = 0;
  };

  // Zufall in [-1, 1) (außerhalb der Audio-Schleifen)
  Synth.prototype.rand = function () {
    var x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x | 0;
    return (x >>> 0) * INV32 * 2 - 1;
  };

  Synth.prototype.configure = function (c) {
    if (!c) return;
    var k;
    for (k in c) {
      if (!Object.prototype.hasOwnProperty.call(c, k) || k === 'profile') continue;
      if (Object.prototype.hasOwnProperty.call(this.cfg, k)) this.cfg[k] = c[k];
    }
    this.cfg.volume = clamp(finite(+this.cfg.volume, 0.6), 0, 1);
    this.cfg.intensity = clamp(finite(+this.cfg.intensity, 0.7), 0, 1);
    this.cfg.carIdle = clamp(finite(+this.cfg.carIdle, 800), 300, 2000);
    this.cfg.carRedline = clamp(finite(+this.cfg.carRedline, 4800), this.cfg.carIdle + 500, 12000);
    if (c.profile && c.profile !== this.cfg.profile && c.profile !== this.pending) {
      // weich aus- und mit neuem Profil wieder einblenden
      this.pending = Profiles.get(c.profile).id;
    }
  };

  Synth.prototype.setParams = function (p) {
    if (!p) return;
    var prevLoad = this.target.load;
    this.target.rpm = clamp(finite(+p.rpm, this.target.rpm), 0, 12000);
    this.target.load = clamp(finite(+p.load, this.target.load), 0, 1);
    this.target.speed = clamp(finite(+p.speed, this.target.speed), 0, 400);
    this.target.overrun = !!p.overrun;
    // Schubumluftventil: Last fällt schlagartig ab
    if (this.profile.turbo && prevLoad > 0.6 && this.target.load < 0.2 && this.rpm > 1800) this.bov = 1;
  };

  // echte Drehzahl -> virtuelle Drehzahl des Profils
  Synth.prototype._virtualRpm = function (real) {
    var p = this.profile, c = this.cfg;
    if (real < 100) return 0; // Motor aus
    var x = (real - c.carIdle) / (c.carRedline - c.carIdle);
    return clamp(p.idleRpm + x * (p.maxRpm - p.idleRpm), p.idleRpm * 0.6, p.maxRpm * 1.04);
  };

  // ---------------------------------------------------------------------------
  // Control-Rate: alles, was sich nur langsam ändert, einmal pro CR Samples
  // ---------------------------------------------------------------------------
  Synth.prototype._control = function () {
    var c = this.cfg, sr = this.sr;
    if (this.pending && this.gain < 0.01) {
      this._setProfile(this.pending);
      this.pending = null;
      this._reset();
    }
    var p = this.profile, P = this.prep;
    var tgtGain = (c.enabled && !this.stale && !this.pending) ? 1 : 0;
    var tgtVol = c.volume * c.volume * p.gain * (c.sport ? 1.3 : 1);
    var tRpm = p.kind === 'electric' ? 0 : this._virtualRpm(this.target.rpm);

    this.rpm += (tRpm - this.rpm) * this.kR;
    this.load += (this.target.load - this.load) * this.kL;
    this.speed += (this.target.speed - this.speed) * this.kS;
    this.gain += (tgtGain - this.gain) * this.kG;
    this.vol += (tgtVol - this.vol) * this.kV;
    var newAmp = this.gain * this.vol * HEADROOM;
    if (newAmp < 1e-5 && tgtGain === 0) newAmp = 0;
    this.ampStep = (newAmp - this.amp) / CR;

    var load = this.load, inten = c.intensity, nyq = sr * 0.45, i, fc;
    var inc = this.inc, w = this.w, n = P.n;

    if (p.kind === 'sample') {
      this.nActive = 0;
      this.level = 0;
      this.noiseAmt = 0;
      fc = 200;
    } else if (p.kind === 'electric') {
      var spd = this.speed;
      var f = p.baseHz * Math.pow(2, spd / p.octaveKmh);
      this.nActive = n;
      for (i = 0; i < n; i++) {
        var dt = f * P.ord[i] * (1 + P.det[i]) / sr;
        if (dt > 0.45) { this.nActive = i; break; }
        inc[i] = dt;
        w[i] = P.amp[i] * P.norm;
      }
      this.subInc = f * 0.5 / sr;
      this.subW = (p.sub || 0) * P.norm;
      fc = p.cutoff * (0.35 + 0.9 * load * inten) + spd * p.cutoffPerKmh;
      this.lfoPhase += p.lfoHz * CR / sr;
      if (this.lfoPhase >= 1) this.lfoPhase -= Math.floor(this.lfoPhase);
      var lfo = 1 - p.lfoDepth * (0.5 + 0.5 * SIN[(this.lfoPhase * TN) | 0]);
      this.level = (0.3 + 0.7 * load) * lfo * (this.target.overrun ? 0.7 : 1);
    } else {
      var rpm = this.rpm, rpmN = rpm / p.maxRpm;
      if (rpm < 50) {
        this.fireInc = 0; this.nActive = 0; this.level = 0; this.noiseAmt = 0; this.turboAmt = 0;
        fc = 200;
      } else {
        var fFire = rpm / 60 * p.cylinders / 2;
        this.fireInc = fFire / sr;
        var bright = p.loadBright * load * inten + p.rpmBright * rpmN;
        this.nActive = n;
        for (i = 0; i < n; i++) {
          var o = P.ord[i], fh = fFire * o;
          if (fh > nyq) { this.nActive = i; break; } // Obertöne aufsteigend sortiert
          inc[i] = fh / sr;
          w[i] = P.amp[i] * P.norm * (o > 1 ? 1 + bright * (o - 1 < 4 ? o - 1 : 4) * 0.5 : 1);
        }
        fc = p.cutoff * (0.6 + 0.7 * load * inten) * (0.6 + 0.6 * rpmN);
        this.level = (0.35 + 0.65 * load) * (0.6 + 0.4 * rpmN) * (this.target.overrun ? 0.55 : 1);
        this.noiseAmt = p.noise * (0.4 + 0.6 * load) * 2.5;
        this.roughAmt = p.roughness * (1 - 0.6 * load);

        if (p.turbo) {
          var boost = clamp((rpm - 1500) / 2000, 0, 1) * load * load;
          this.turboAmt = boost > 0.001 ? p.turbo * boost * 0.06 : 0;
          this.turboInc = (3500 + rpm * 1.4) / sr;
        } else this.turboAmt = 0;

        // Pops & Bangs im Schub
        if (c.pops && p.popRate && this.target.overrun && rpm > 2200) {
          var prob = p.popRate * rpmN * CR / sr;
          if ((this.rand() + 1) * 0.5 < prob) { this.pop = 0.6 + 0.4 * (this.rand() + 1) * 0.5; this.popPhase = 0; }
        }
      }
    }
    fc = clamp(fc, 80, Math.min(7000, sr / 6));
    this.fq = 2 * Math.sin(Math.PI * fc / sr);
    this.nk = clamp(fc / sr * 3, 0.01, 0.9);
  };

  // ---------------------------------------------------------------------------
  // Audio-Schleife Verbrenner (n Samples ab Frame `off`)
  // ---------------------------------------------------------------------------
  Synth.prototype._blockComb = function (out, off, n) {
    var T = SIN, ph = this.phases, inc = this.inc, w = this.w, H = this.nActive;
    var fire = this.firePhase, fireInc = this.fireInc, rough = this.rough, roughT = this.roughTarget, roughAmt = this.roughAmt;
    var low = this.low, band = this.band, fq = this.fq;
    var nlp = this.noiseLp, nk = this.nk, noiseAmt = this.noiseAmt, level = this.level;
    var tPh = this.turboPhase, tInc = this.turboInc, tAmt = this.turboAmt;
    var bov = this.bov, bovDec = this.bovDecay, nlp2 = this.noiseLp2, bovAmt = (this.profile.turbo || 0) * 0.25;
    var pop = this.pop, popPh = this.popPhase, popInc = this.popInc, popDec = this.popDecay;
    var amp = this.amp, ampStep = this.ampStep, drive = this.drive, dn = this.driveNorm;
    var seed = this.seed | 0, peak = 0, bad = false;
    var k, j, x, fi, ii, sum, s, r, e, y, a, o = off * 2;

    for (k = 0; k < n; k++) {
      fire += fireInc;
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      r = (seed >>> 0) * INV32 * 2 - 1;
      if (fire >= 1) { fire -= 1; roughT = 1 + roughAmt * r; }
      rough += (roughT - rough) * 0.02;

      sum = 0;
      for (j = 0; j < H; j++) {
        x = ph[j] + inc[j];
        if (x >= 1) x -= 1;
        ph[j] = x;
        fi = x * TN; ii = fi | 0;
        sum += w[j] * (T[ii] + (T[ii + 1] - T[ii]) * (fi - ii));
      }
      // Klangfilter (State-Variable-Tiefpass)
      low += fq * band;
      band += fq * (sum - low - 1.2 * band);
      s = low * level * rough;

      // Auspuffrauschen, im Takt der Zündungen gepulst (cos über Tabelle)
      nlp += (r - nlp) * nk;
      x = fire + 0.25; if (x >= 1) x -= 1;
      e = 0.5 + 0.5 * T[(x * TN) | 0];
      s += nlp * e * e * e * noiseAmt;

      if (tAmt > 0) {
        tPh += tInc; if (tPh >= 1) tPh -= 1;
        s += tAmt * T[(tPh * TN) | 0];
      }
      if (bov > 0.001) {
        nlp2 += (r - nlp2) * 0.3;
        s += (r - nlp2) * bov * bovAmt;
        bov *= bovDec;
      }
      if (pop > 0.001) {
        popPh += popInc; if (popPh >= 1) popPh -= 1;
        s += (r * 0.7 + T[(popPh * TN) | 0]) * pop * 0.9;
        pop *= popDec;
      }

      // Sättigung, Pegel, Begrenzung
      y = s * drive;
      s = y / (1 + (y < 0 ? -y : y)) * dn;
      amp += ampStep;
      s *= amp;
      if (s > 1) s = 1; else if (s < -1) s = -1; else if (s !== s) { s = 0; bad = true; }
      out[o++] = s; out[o++] = s;
      a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }

    this.firePhase = fire; this.rough = rough; this.roughTarget = roughT;
    this.low = low; this.band = band; this.noiseLp = nlp; this.noiseLp2 = nlp2;
    this.turboPhase = tPh; this.bov = bov; this.pop = pop; this.popPhase = popPh;
    this.amp = amp; this.seed = seed;
    if (bad || low !== low || band !== band) this._reset();
    return peak;
  };

  // ---------------------------------------------------------------------------
  // Audio-Schleife Elektro (alias-arme Sägezähne per PolyBLEP + Sub-Sinus)
  // ---------------------------------------------------------------------------
  Synth.prototype._blockElec = function (out, off, n) {
    var T = SIN, ph = this.phases, inc = this.inc, w = this.w, V = this.nActive;
    var sPh = this.subPhase, sInc = this.subInc, sW = this.subW;
    var low = this.low, band = this.band, fq = this.fq, level = this.level;
    var amp = this.amp, ampStep = this.ampStep, drive = this.drive, dn = this.driveNorm;
    var peak = 0, bad = false;
    var k, j, x, dt, t, saw, sum, s, y, a, o = off * 2;

    for (k = 0; k < n; k++) {
      sum = 0;
      for (j = 0; j < V; j++) {
        dt = inc[j];
        x = ph[j] + dt;
        if (x >= 1) x -= 1;
        ph[j] = x;
        saw = 2 * x - 1;
        if (x < dt) { t = x / dt; saw -= t + t - t * t - 1; }
        else if (x > 1 - dt) { t = (x - 1) / dt; saw -= t * t + t + t + 1; }
        sum += w[j] * saw;
      }
      sPh += sInc; if (sPh >= 1) sPh -= 1;
      sum += sW * T[(sPh * TN) | 0];

      low += fq * band;
      band += fq * (sum - low - 0.9 * band);
      s = low * level;

      y = s * drive;
      s = y / (1 + (y < 0 ? -y : y)) * dn;
      amp += ampStep;
      s *= amp;
      if (s > 1) s = 1; else if (s < -1) s = -1; else if (s !== s) { s = 0; bad = true; }
      out[o++] = s; out[o++] = s;
      a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    this.subPhase = sPh; this.low = low; this.band = band; this.amp = amp;
    if (bad || low !== low || band !== band) this._reset();
    return peak;
  };

  /**
   * Füllt `out` (Float32Array, Stereo interleaved, Länge >= frames*2) mit Samples in [-1, 1].
   * Gibt den Spitzenwert zurück.
   */
  Synth.prototype._blockSample = function (out, off, n) {
    if (!this.b57) {
      var j = off * 2;
      for (var i = 0; i < n; i++) { out[j++] = 0; out[j++] = 0; }
      this.amp += this.ampStep * n;
      return 0;
    }
    var r = this.b57.render(out, off, n, this.amp, this.ampStep, this.rpm, this.load,
      this.target.overrun, this.cfg.intensity);
    this.amp = r.amp;
    return r.peak;
  };

  Synth.prototype.render = function (out, frames) {
    var peak = 0, i = 0, n, pk;
    while (i < frames) {
      if (this.cnt <= 0) { this._control(); this.cnt = CR; }
      n = frames - i < this.cnt ? frames - i : this.cnt;
      if (this.amp === 0 && this.ampStep === 0) {
        // Stille: nichts berechnen
        for (var z = i * 2, end = (i + n) * 2; z < end; z++) out[z] = 0;
      } else {
        pk = this.profile.kind === 'sample' ? this._blockSample(out, i, n) : (this.profile.kind === 'electric' ? this._blockElec(out, i, n) : this._blockComb(out, i, n));
        if (pk > peak) peak = pk;
      }
      i += n;
      this.cnt -= n;
    }
    return peak;
  };

  Synth.prototype.state = function () {
    return {
      profile: this.cfg.profile, rpm: this.rpm, load: this.load, speed: this.speed,
      gain: this.gain, enabled: this.cfg.enabled
    };
  };

  return Synth;
});
