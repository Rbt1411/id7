/*
 * Iconix Sounds – Sound-Profile
 *
 * Gemeinsame Datei für: App (Head Unit), Audio-Daemon (Head Unit, Node 8) und PC-Simulator (Browser).
 * Kanonische Quelle ist shared/profiles.js – die Kopien in apps/ und tools/ erzeugt `npm run sync`.
 * Nur ES2017-Syntax verwenden (Node 8.16 auf dem Head Unit).
 *
 * Verbrenner-Profile ("combustion"):
 *   cylinders   virtuelle Zylinderzahl (bestimmt die Zündfrequenz: U/min / 60 * Zyl / 2)
 *   idleRpm/maxRpm  virtueller Drehzahlbereich; die echte Drehzahl des Autos wird darauf abgebildet
 *   harmonics   [Ordnung relativ zur Zündfrequenz, Amplitude]
 *   loadBright  wie stark höhere Ordnungen unter Last zunehmen
 *   rpmBright   wie stark höhere Ordnungen mit der Drehzahl zunehmen
 *   roughness   Unruhe pro Arbeitstakt (0 = seidig, 0.2 = rau)
 *   noise       Auspuff-/Ansaugrauschen
 *   cutoff      Klangfilter in Hz (öffnet mit Last und Drehzahl)
 *   drive       Sättigung / Verzerrung
 *   turbo       Turbo-Pfeifen und Schubumluft (0..1)
 *   popRate     Patscher pro Sekunde im Schubbetrieb (nur wenn "Pops" aktiv)
 *
 * Elektro-Profile ("electric"):
 *   baseHz      Grundton im Stand
 *   octaveKmh   alle X km/h steigt der Ton um eine Oktave
 *   voices      [Frequenzverhältnis, Amplitude, Verstimmung]
 *   sub         Sub-Sinus eine Oktave tiefer
 *   cutoff / cutoffPerKmh  Filter
 *   lfoHz / lfoDepth       langsames Schweben bzw. Tremolo
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IconixProfiles = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIST = [
    {
      id: 'six', name: 'Reihensechser Sport', kind: 'combustion',
      cylinders: 6, idleRpm: 750, maxRpm: 7000, gain: 0.95,
      harmonics: [[0.5, 0.22], [1, 1], [1.5, 0.18], [2, 0.55], [3, 0.3], [4, 0.18], [5, 0.08], [6, 0.05]],
      loadBright: 0.9, rpmBright: 0.35, roughness: 0.04, noise: 0.08, cutoff: 2600, drive: 1.6,
      turbo: 0.3, popRate: 6
    },
    {
      id: 'v8', name: 'V8 Bariton', kind: 'combustion',
      cylinders: 8, idleRpm: 650, maxRpm: 6800, gain: 1.0,
      harmonics: [[0.5, 0.6], [0.75, 0.22], [1, 1], [1.5, 0.32], [2, 0.42], [3, 0.16], [4, 0.08]],
      loadBright: 0.8, rpmBright: 0.25, roughness: 0.12, noise: 0.12, cutoff: 1800, drive: 2.2,
      turbo: 0, popRate: 14
    },
    {
      // Für Diesel-Fahrzeuge gedacht, klingt aber bewusst NICHT nach Diesel: kein Nageln
      // (kaum Unruhe, wenig Rauschen, keine hohen Ordnungen), dafür ein warmes, sonores Grollen
      // durch Halbordnungen. Beim Gleiten unauffällig, unter Last kerniger (hohe loadBright,
      // kleine rpmBright). Das 220d-Drehzahlband (bis ca. 4800) wird auf bis zu 6800 virtuelle U/min
      // gestreckt – dadurch wirkt es drehfreudig.
      id: 'subtle', name: 'Sport Dezent', kind: 'combustion',
      cylinders: 6, idleRpm: 700, maxRpm: 6800, gain: 0.8,
      harmonics: [[0.5, 0.28], [1, 1], [1.5, 0.35], [2, 0.45], [2.5, 0.12], [3, 0.18], [4, 0.07]],
      loadBright: 1.0, rpmBright: 0.15, roughness: 0.025, noise: 0.05, cutoff: 1400, drive: 1.7,
      turbo: 0.1, popRate: 3
    },
    {
      id: 'turbo4', name: 'Turbo Vierzylinder', kind: 'combustion',
      cylinders: 4, idleRpm: 800, maxRpm: 6800, gain: 0.9,
      harmonics: [[0.5, 0.3], [1, 1], [1.5, 0.25], [2, 0.6], [3, 0.3], [4, 0.2]],
      loadBright: 0.9, rpmBright: 0.3, roughness: 0.08, noise: 0.15, cutoff: 3000, drive: 1.8,
      turbo: 1, popRate: 10
    },
    {
      id: 'v10', name: 'Racing V10', kind: 'combustion',
      cylinders: 10, idleRpm: 1000, maxRpm: 8500, gain: 0.85,
      harmonics: [[0.5, 0.2], [1, 1], [2, 0.7], [3, 0.45], [4, 0.3], [5, 0.15], [6, 0.1]],
      loadBright: 1.0, rpmBright: 0.45, roughness: 0.05, noise: 0.1, cutoff: 4500, drive: 2.0,
      turbo: 0, popRate: 8
    },
    {
      id: 'edrive', name: 'Electric Drive', kind: 'electric', gain: 0.8,
      baseHz: 55, octaveKmh: 80,
      voices: [[1, 1, 0], [1, 0.8, 0.007], [2, 0.35, -0.004], [3, 0.12, 0.002]],
      sub: 0.6, cutoff: 900, cutoffPerKmh: 12, lfoHz: 0.3, lfoDepth: 0.15, drive: 1.2
    },
    {
      id: 'espace', name: 'Electric Space', kind: 'electric', gain: 0.75,
      baseHz: 73.4, octaveKmh: 70,
      voices: [[1, 1, 0], [1.5, 0.6, 0.004], [2, 0.5, -0.006], [3, 0.25, 0.003], [4, 0.15, -0.002]],
      sub: 0.4, cutoff: 1400, cutoffPerKmh: 16, lfoHz: 4.5, lfoDepth: 0.12, drive: 1.1
    },
    {
      id: 'b57_540d', name: 'Audi A6 3.0 BiTDI', kind: 'sample',
      cylinders: 6, idleRpm: 750, maxRpm: 4550, gain: 1.0,
      harmonics: [], turbo: 0, popRate: 0
    }
  ];

  var BY_ID = {};
  LIST.forEach(function (p, i) { p.index = i; BY_ID[p.id] = p; });

  return {
    DEFAULT: 'subtle',
    list: LIST,
    ids: LIST.map(function (p) { return p.id; }),
    get: function (id) { return BY_ID[id] || BY_ID.six; },
    next: function (id, step) {
      var i = (BY_ID[id] ? BY_ID[id].index : 0) + (step || 1);
      i = ((i % LIST.length) + LIST.length) % LIST.length;
      return LIST[i].id;
    }
  };
});
