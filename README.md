# RT-APPS · BMW iDrive 7

Eigene Zusammenstellung und Weiterentwicklung von Anwendungen fuer BMW MGU / iDrive 7.

## Verfuegbare Anwendungen

| App | Version | Zweck |
| --- | --- | --- |
| **DPF Monitor** | **0.1.1** | Partikelfilter: Messwerte, Regenerationsdaten und Verlauf |
| **Iconix Sounds** | **0.5.4** | Experimentelle Soundprofile fuer das Infotainment |

**Hinweis zum Betrieb:** Nicht alle Messwerte und nicht die Soundausgabe sind fuer jedes Fahrzeug verifiziert. Kein Ersatz fuer Fahrzeugdiagnose. Bitte nur im Stand konfigurieren und testen.


## Iconix 0.5.4 – SmartX/CarLife Beta

- **Neu:** Ausgabegeraet `SmartX / CarLife (Beta)`. Standard bleibt `Automatisch`; keine Audio-Umschaltung ohne bewusste Auswahl.
- **Testsound:** Im geparkten Fahrzeug bei kleiner Lautstaerke laesst sich ein ca. 9-Sekunden-Profiltest anfordern.
- **Dauerbetrieb:** eigene Einstellung `SmartX Dauerbetrieb (Beta; nach Test)`, standardmaessig AUS. Nur mit aktuellen Drehzahldaten und eingeschaltetem Sound wird die Route angefordert.
- **Wiedergabe:** 48 kHz Stereo-S16 an `plug:smartx:CarLifeMedia_CF_48_STEREO`, Verbindung AudioManager 287 → 1024 (nur wenn Quelle frei). Alle 600 ms Route-Heartbeat, stoppt bei verlorener Verbindung.
- **Hinweis:** Der CarLife-Medienkanal kann CarPlay unterbrechen, *gleichzeitige* Wiedergabe ist nicht nachgewiesen. Keine Garantie fuer Sicherheitswarnsignale. Zuerst nur im geparkten Auto testen und bei Problemen SmartX wieder deaktivieren.
- **Unveraendert aus deinem Upload:** DPF Monitor 0.1.1; die komplette App einschliesslich Vendor-Quellen ist unveraendert uebernommen. SmartX Audio Test 0.1.2 mitsamt `smartx-testd` wurde ergaenzt.
- **Nicht getestet:** Live-Audioausgabe auf dieser BMW-MGU, dynamischer B57-Sound mit SmartX und Medien-Mixing.

## MGU Store

- Quelle: `Rbt1411/id7`
- Branch: `main`
- App-Katalog: `mgu-repo.json`
- App-Quellen: `apps/dpf/` und `apps/iconix_sounds/`
- Optionaler Audio-Dienst: `tools/iconix-audiod/`

`kit/tools/build.py` baut die App-Pakete. Die zugehoerigen technischen Bibliotheken liegen unter `vendors/dpf_core/` und `vendors/iconix_core/`.

Nach einem GitHub-Commit die Quelle im MGU Store aktualisieren. Eine automatische Installation von Updates ist nicht zugesichert.

## Entwicklung und Rechte

RT-APPS ist die Bezeichnung dieser angepassten Projektzusammenstellung. Darin enthaltene Drittanbieter-Bibliotheken und uebernommene Programmteile bleiben Werke ihrer jeweiligen Urheber. Die Copyright- und Lizenztexte stehen weiterhin in den Quellordnern und sind in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) zusammengefasst.

**Hinweis zur Weitergabe:** Fuer die mitgelieferten B57-Sounddateien sind die oeffentlichen Verbreitungsrechte noch nicht geklaert. Vor einer oeffentlichen Veroeffentlichung die Rechte pruefen oder die betreffenden Dateien herausnehmen.
