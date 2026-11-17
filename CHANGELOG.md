## 0.5.4 – 2026-11-17


## Iconix 0.5.4 – SmartX/CarLife Beta

- **Neu:** Ausgabegeraet `SmartX / CarLife (Beta)`. Standard bleibt `Automatisch`; keine Audio-Umschaltung ohne bewusste Auswahl.
- **Testsound:** Im geparkten Fahrzeug bei kleiner Lautstaerke laesst sich ein ca. 9-Sekunden-Profiltest anfordern.
- **Dauerbetrieb:** eigene Einstellung `SmartX Dauerbetrieb (Beta; nach Test)`, standardmaessig AUS. Nur mit aktuellen Drehzahldaten und eingeschaltetem Sound wird die Route angefordert.
- **Wiedergabe:** 48 kHz Stereo-S16 an `plug:smartx:CarLifeMedia_CF_48_STEREO`, Verbindung AudioManager 287 → 1024 (nur wenn Quelle frei). Alle 600 ms Route-Heartbeat, stoppt bei verlorener Verbindung.
- **Hinweis:** Der CarLife-Medienkanal kann CarPlay unterbrechen, *gleichzeitige* Wiedergabe ist nicht nachgewiesen. Keine Garantie fuer Sicherheitswarnsignale. Zuerst nur im geparkten Auto testen und bei Problemen SmartX wieder deaktivieren.
- **DPF unveraendert:** Originale DPF Monitor 0.1.1 Dateien aus `id7-main(5).zip` beibehalten. SmartX Audio Test 0.1.2 mitsamt `smartx-testd` ergaenzt.
- **Nicht getestet:** Live-Audioausgabe auf dieser BMW-MGU, dynamischer B57-Sound mit SmartX und Medien-Mixing.

# Changes

Newest first. Dates are when the build was pushed.

## Nov 9 2026

New