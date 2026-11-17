# RT-APPS · BMW iDrive 7

Eigene Zusammenstellung und Weiterentwicklung von Anwendungen fuer BMW MGU / iDrive 7.

## Verfuegbare Anwendungen

| App | Version | Zweck |
| --- | --- | --- |
| **DPF Monitor** | **0.1.1** | Partikelfilter: Messwerte, Regenerationsdaten und Verlauf |
| **Iconix Sounds** | **0.5.3** | Experimentelle Soundprofile fuer das Infotainment |

**Hinweis zum Betrieb:** Nicht alle Messwerte und nicht die Soundausgabe sind fuer jedes Fahrzeug verifiziert. Kein Ersatz fuer Fahrzeugdiagnose. Bitte nur im Stand konfigurieren und testen.

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
