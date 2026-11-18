'use strict';
/*
 * Iconix Sounds – Fahrzeugdaten über SOME/IP (ctx.signals des idrive7-apps-Kits)
 *
 * Signale und Skalierung laut idrive7-apps (live_data/signals.js, README Abschnitt 7):
 *   Drehzahl  CDS.statusEngineSpeed2.actualValueRPMEngineCrankshaft      * 0.25      (65535 = ungültig)
 *   Tempo     Vehicle2.statusCarSpeed2.speedVehicleCentreOfGravity        * 0.015625  (65535 = ungültig)
 *   Moment    FES.statusActualValueTorque2.actualValueTorqueCrankshaft    * 0.5 - 1023.5 Nm (4095 = ungültig)
 *   Gaspedal  AcceleratorPedal.AngleAcceleratorPedal.actualValueAngleAcceleratorPedal * 0.025 % (UNBESTÄTIGT)
 *
 * Abgeglichen mit idrive7-apps: kit/runtime/signals.js (watch ist async, liefert das Struct mit Rohwerten,
 * abonniert die Felder – kein Polling nötig) und kit/runtime/car.js (Faktoren, ungültige Rohwerte).
 * Die ersten Rohwerte werden geloggt (data/iconix_sounds.log).
 */
const EventEmitter = require('events');

const IF = {
  CDS: 'de.bmw.infotainment.vehicle.CDS',
  V2: 'de.bmw.infotainment.vehicle.Vehicle2',
  FES: 'de.bmw.infotainment.drivingexcitement.FES',
  PEDAL: 'de.bmw.powertrain.AcceleratorPedal'
};
const FRESH_MS = 1500;

function pick(v, member) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof v[member] === 'number') return v[member];
  return null;
}
function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

class VehicleFeed extends EventEmitter {
  /**
   * @param signals  ctx.signals (Kit)
   * @param log      ctx.log
   * @param getCfg   () => { loadSource, maxTorque, carIdle }
   */
  constructor(signals, log, getCfg) {
    super();
    this.signals = signals;
    this.log = log;
    this.getCfg = getCfg;
    this.v = { rpm: 0, rpmAt: 0, speed: 0, speedAt: 0, torque: 0, torqueAt: 0, pedal: 0, pedalAt: 0 };
    this.rpmHist = [];
    this.load = 0;
    this.watches = [];
    this.logged = {};
  }

  start() {
    if (!this.signals || typeof this.signals.watch !== 'function') {
      this.log.warn('iconix: ctx.signals.watch nicht verfügbar – keine Fahrzeugdaten');
      return;
    }
    this._watch(IF.CDS, {
      statusEngineSpeed2: v => {
        const raw = pick(v, 'actualValueRPMEngineCrankshaft');
        this._first('rpm', v);
        if (raw === null || raw === 65535) return;
        this.v.rpm = raw * 0.25; this.v.rpmAt = Date.now();
        this._recordRpm();
        this._sample();
      }
    });
    this._watch(IF.V2, {
      statusCarSpeed2: v => {
        const raw = pick(v, 'speedVehicleCentreOfGravity');
        this._first('speed', v);
        if (raw === null || raw === 65535) return;
        this.v.speed = raw * 0.015625; this.v.speedAt = Date.now();
      }
    });
    this._watch(IF.FES, {
      statusActualValueTorque2: v => {
        const raw = pick(v, 'actualValueTorqueCrankshaft');
        this._first('torque', v);
        if (raw === null || raw >= 4095) return; // 12 Bit, 4095 = kein Wert (car.js)
        this.v.torque = raw * 0.5 - 1023.5; this.v.torqueAt = Date.now();
        this._sample();
      }
    });
    this._watch(IF.PEDAL, {
      AngleAcceleratorPedal: v => {
        const raw = pick(v, 'actualValueAngleAcceleratorPedal');
        this._first('pedal', v);
        if (raw === null) return;
        const pct = raw * 0.025;
        if (pct < -2 || pct > 102) return;
        this.v.pedal = clamp(pct, 0, 100); this.v.pedalAt = Date.now();
        this._sample();
      }
    });
  }

  stop() {
    this.watches.forEach(w => { try { if (w && w.shutdown) w.shutdown(); } catch (e) { /* egal */ } });
    this.watches = [];
  }

  // signals.watch ist async und liefert { iface, available, proxy, error, shutdown }
  _watch(iface, handlers) {
    let p;
    try { p = this.signals.watch(iface, '1', handlers, this.log); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(w => {
      if (!w) return;
      this.watches.push(w);
      if (w.error) this.log.warn('iconix: ' + iface + ' nicht verfügbar: ' + w.error);
      else this.log.info('iconix: ' + iface + ' abonniert');
    }).catch(e => this.log.warn('iconix: watch ' + iface + ' fehlgeschlagen: ' + (e && e.message)));
  }

  // die ersten Rohwerte ins Log schreiben (zur Kontrolle der Skalierung)
  _first(name, v) {
    const n = this.logged[name] || 0;
    if (n < 3) {
      this.logged[name] = n + 1;
      try { this.log.info('iconix: raw ' + name + ' = ' + JSON.stringify(v)); } catch (e) { /* egal */ }
    }
  }

  fresh(key) { return Date.now() - this.v[key + 'At'] < FRESH_MS; }

  // Keep RPM derivative history tied to true RPM events; torque/pedal events
  // must not insert duplicate RPM values or distort fallback load estimation.
  _recordRpm() {
    const now = Date.now();
    this.rpmHist.push([now, this.v.rpm]);
    while (this.rpmHist.length > 2 && now - this.rpmHist[0][0] > 300) this.rpmHist.shift();
  }

  _sample() {
    const cfg = this.getCfg();
    const now = Date.now();
    const rpm = this.v.rpm;
    let load = 0, overrun = false, src = cfg.loadSource;

    if (src === 'auto') src = this.fresh('torque') ? 'torque' : (this.fresh('pedal') ? 'pedal' : 'rpm');

    if (src === 'torque' && this.fresh('torque')) {
      load = clamp(this.v.torque / (cfg.maxTorque || 400), 0, 1);
      overrun = this.v.torque < -3 && rpm > cfg.carIdle + 300;
    } else if (src === 'pedal' && this.fresh('pedal')) {
      load = this.v.pedal / 100;
      overrun = this.v.pedal < 1 && rpm > cfg.carIdle + 400;
    } else {
      // Ersatz: Drehzahlanstieg der letzten ~300 ms
      const h0 = this.rpmHist[0] || [now, rpm];
      const dt = (now - h0[0]) / 1000;
      const slope = dt > 0.05 && this.fresh('rpm') ? (rpm - h0[1]) / dt : 0; // U/min pro Sekunde
      load = clamp(slope / 1500, 0, 1);
      overrun = slope < -300 && rpm > cfg.carIdle + 400;
    }
    // leicht glätten, damit Lastsprünge nicht knacken
    this.load += (load - this.load) * 0.5;

    this.emit('sample', {
      rpm: rpm,
      load: this.load,
      speed: this.fresh('speed') ? this.v.speed : 0,
      overrun: overrun,
      src: src,
      at: now
    });
  }
}

module.exports = VehicleFeed;
module.exports.IF = IF;
