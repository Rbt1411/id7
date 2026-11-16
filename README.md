## Iconix Sounds 0.5.3 — Anzeige im MGU Store

Die App liegt unter `apps/iconix_sounds/app.json`. Im MGU Store die GitHub-Quelle `Rbt1411/id7` mit Branch `main` aktualisieren. Soundausgabe ueber MGU-Lautsprecher ungetestet.

# Rbt1411 / id7 – korrigierter MGU-Store-Build + B57 Sport

Dieses ZIP basiert auf der hochgeladenen `id7-main(1).zip`.

## Enthalten

- DPF Status 0.1.25, Spritmonitor 0.1.24, Drive Coach 1.0.1
- Iconix Sounds 0.5.3 mit allen sieben bisherigen Profilen und zusätzlichem **BMW B57 540d Sport**
- Iconix Audio-Dienst 0.5.3 mit den drei lokalen B57-WAV-Aufnahmen (Leerlauf, Gas, Schub)

## Reparatur der fehlenden dist/*.tgz Dateien

`kit/tools/build.py` ruft die projektspezifischen Build-Skripte auf und legt deren Ergebnis
auch im Repo-Hauptordner unter `dist/<app>@<version>.tgz` ab. Es überprüft das Archiv.
`vendors/nico/kit/tools/build.py` unterstützt nun Store-Builds mit `MGU_OUT`
ohne lokal mitgelieferte BMW-SDK-Dateien und übernimmt die WAV-Dateien in die App.
Alle Apps verwenden den gleichen Ausgabeweg.

## GitHub

**Nur den Inhalt** dieser ZIP in das **Stammverzeichnis** des GitHub-Repositories
hochladen, sodass `mgu-repo.json` direkt auf der Repo-Hauptseite liegt.
Keine zweite Unterebene `id7-main/` anlegen und die ZIP nicht als einzelne Datei hochladen.
Mit einem neuen Commit erneut im MGU Store aktualisieren (ggf. Quelle neu laden).

## Validierung und Grenzen

`python3 tests/check_repo.py` kontrolliert die Dateien und das Build-Verhalten.
Mit `MGU_OUT=<temporärer Ordner> python3 kit/tools/build.py <app>` erstellt das
jeweilige Skript einen Store-kompatiblen Quellpaket-Tarball. Ein Build
mit dem **echten BMW-SDK**, eine Installation auf dem MGU und die Audioausgabe
über die serienmäßigen BMW-Lautsprecher sind hier nicht nachgewiesen.

Zum Sound: In Iconix Sounds das Profil „BMW B57 540d Sport“ wählen.
Iconix Audio ist ein separates experimentelles Tool und muss zusätzlich
installiert sein. Zuerst im Stand bei niedriger Lautstärke testen.

Die B57-Audiodaten stammen aus dem vom Nutzer bereitgestellten Aquaphobic-Modpaket;
Verbreitungsrechte für ein öffentliches Repository sind nicht geklärt.
