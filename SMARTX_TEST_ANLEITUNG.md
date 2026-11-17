# SmartX Audio Test für BMW iDrive 7 – EXPERIMENTELL

**Zweck:** Nur einen leisen ca. 1-sekündigen Ton über `plug:smartx:CarLifeMedia_CF_48_STEREO` testen. Kein Dauerbetrieb des B57-Sounds. Iconix Sounds 0.5.3 und dessen WAV-Dateien wurden nicht verändert.

## Installation
1. Vorher Repo sichern. Den gesamten entpackten Inhalt ohne zusaetzlichen Unterordner nach GitHub `Rbt1411/id7` kopieren; die geaenderten Dateien ersetzen.
2. MGU Store Quelle aktualisieren. `SmartX Testdienst` in Tools und `SmartX Audio Test` in Apps installieren. Ein funktionsfaehiges Python 3 (z. B. MGU Python Tool) muss bereits vorhanden sein. Diese sind eigenstaendig; `iconix-audiod` muss nicht deinstalliert werden.
3. Fahrzeug sicher parken, Motor kann aus sein. Normale Musik/Radios stumm bzw. BMW-Lautstaerke auf sehr niedrig. Iconix Sounds selbst stummschalten.
4. `SmartX Audio Test` oeffnen, `Dienst pruefen`, dann **einmal** `Testton (nur im Stand)`. Es ist ein kurzer, leiser 420-Hz-Ton zu erwarten.
5. App meldet, ob AudioManager-Routing und SmartX-PCM-Schreiben geklappt haben. **Schreiben != hoerbarer Ton**. Wenn kein Ton, Fehler oder Radio/Telefonie betroffen: `Stop / Audio freigeben`, App beenden, nicht waehrend der Fahrt testen.

## Grenzen und Sicherheit
- Dieser erste Test benutzt den CarLife-**Medienkanal** (Quell-ID 287, Senke 1024), nicht einen bestaetigt mit CarPlay mischbaren Effektkanal. CarPlay-/Radio-Audio kann deshalb zeitweise unterbrochen werden.
- Die App verweigert die Wiedergabe, wenn das aktuelle Fahrzeugtempo nicht frisch und nahezu null ist; Failsafe bei Bewegung. Der Dienst spielt maximal 1 Sekunde, beendet nach Timeout.
- Die AudioManager-Verbindung wird nur fuer den Test hergestellt und danach getrennt. Die Verbindung kann bei einem App-Crash kurz bestehen bleiben; nach Neustart des Tools/der App wird eine anhand der eigenen ID identifizierte Verbindung freigegeben.
- Die Diagnose garantiert nicht, dass auf jedem MGU SmartX verfügbar ist oder der Ton zur Lautsprecher-Senke geroutet wird. Niemals bestehende BMW-Audiodienste beenden oder HFP-/Warn-Kanaele umleiten.
- **Der B57-Motorsound laeuft danach nicht automatisch**. Erst nach einem erfolgreichen Ton- und Medienvertraeglichkeitstest liesse sich die Wiedergabe in Iconix integrieren.

## Quelle
SmartX-ALSA-Ziel, AudioManager-Verbindung und die Datei `car_audio.js` stammen aus bzw. orientieren sich am vom Nutzer hochgeladenen `aurelmarius/bmw-apps`, `apps/aurelm_tvhplayer/car_audio.js` und `native/tvh-player/src/player.cpp`. Quelle: https://github.com/aurelmarius/bmw-apps. `car_audio.js` verweist auf Moonride (GPL-3.0-or-later). Vor oeffentlicher Weiterverbreitung bitte die Lizenzen der upstream Komponenten beachten.

## Nicht geloeste Fragen
- Kann die Route parallel zu Apple CarPlay-Medien genutzt werden? Unbestaetigt.
- Existieren zusaetzliche, offiziell geeignete Audio-Mischkanäle? Unbestaetigt.
- Wie verhaelt sich das Testprogramm auf deinem echten G31? Nicht getestet.

## Dieses kombinierte Repository

Basis: `id7_DPF_0.2.0_ohne_Spritmonitor_Drive_Coach(1).zip` (keine Wiederaufnahme der entfernten Apps).
Der SmartX-Test wurde hinzugefuegt; Iconix Sounds 0.5.3 und seine B57-WAVs bleiben byteidentisch.
DPF 0.2.0 bleibt erhalten.
Die Audioausgabe auf der echten BMW-MGU ist weiterhin ungetestet.
