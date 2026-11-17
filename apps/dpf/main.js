'use strict';
/**
 * Partikelfilter – der DPF-Monitor (apps/dpf) im Stil der BMW-iDrive-7-Anzeigen.
 *
 * Das HMI zeichnet den Titel und die Schaltflächenleiste selbst
 * (Einstellung „Bildschirmlayout“ = iDrive, die Standardeinstellung).
 * Die App zeichnet nur den Seiteninhalt dazwischen: schwarzer Hintergrund,
 * feine Linien, helle Schrift, schräge silberne Balken mit rotem Zeiger
 * und eine Partikelfilter-Grafik auf der rechten Seite.
 *
 * Seiten (HMI-Schaltflächen „Übersicht“, „Live-Daten“, „Verlauf“;
 * bei Vollbilddarstellung als Registerkarten):
 *   Übersicht   Rußmasse und Abgastemperatur als Balken, Filtergrafik mit
 *               Ruß, Asche, Wärme und Differenzdruck sowie Statusanzeige
 *   Live-Daten  Rußmasse, Differenzdruck und Abgastemperaturen mit Verlauf
 *               der letzten fünf Minuten; weitere Werte als Liste
 *               (mit Rohantworten: Kennung und Antwort des Steuergeräts)
 *   Verlauf     beobachtete Regenerationen und Intervalle aus der DDE
 *
 * Verwendet ausschließlich lesende UDS-Abfragen (0x22).
 * Eine aus Messwerten vermutete aktive Regeneration ist im realen Fahrzeug
 * ausdrücklich NICHT als bestätigt anzusehen.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const { DemoDpf } = require('./demo');
const ID7 = require('./id7');
const { drawDpf } = require('./illustration');
const RegenEvidence = require('./regen-evidence');

const W = 1600, H = 520;
const PAGES = ['Übersicht', 'Live-Daten', 'Verlauf'];
const BUTTONS = ['BTN_OVERVIEW', 'BTN_LIVE', 'BTN_HISTORY'];
const FAST = ['soot', 'regenReq', 'dp', 'tDpf', 'tOxi'];                 // bei jedem Durchlauf
const SLOW = ['sootSim', 'ash', 'distSince', 'avgInterval', 'fuelSince', 'interrupted', 'lock', 'flowRes', 'timeSince'];   // bei jedem fünften Durchlauf
const ALL = FAST.concat(SLOW);
const NAMES = {
    soot: 'Rußmasse (gemessen)', sootSim: 'Rußmasse (berechnet)', ash: 'Ölaschemasse', distSince: 'Strecke seit Regeneration',
    avgInterval: 'Mittleres Reg.-Intervall', fuelSince: 'Kraftstoff seit Regeneration', regenReq: 'Reg.-Anforderung (nicht aktiv)',
    interrupted: 'Reg.-Unterbrechungsstatus', lock: 'Regenerationssperre', dp: 'Differenzdruck',
    tDpf: 'Abgastemperatur vor DPF', tOxi: 'Abgastemperatur vor Oxikat', flowRes: 'Strömungswiderstand (gefiltert)', timeSince: 'Motorlaufzeit seit Regeneration',
};
const UNITS = { soot: 'g', sootSim: 'g', ash: 'g', distSince: 'km', avgInterval: 'km', fuelSince: 'l', dp: 'mbar', tDpf: '°C', tOxi: '°C', flowRes: 'hPa/(m3/h)', timeSince: 's' };
const DEFAULT_THRESHOLD = 24;      // g; bis zum beobachteten Regenerationsbeginn (Einstellung „Regeneration beginnt bei“)
const TRACE_S = 2, TRACE_N = 900;  // ein Messpunkt alle 2 s, insgesamt 30 min
const SPARK_N = 150;               // Diagrammlinien: die letzten 5 min

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const cfg = Object.assign({ ecu: 18, history: [] }, (ctx.spec.config && ctx.spec.config.dpf) || {});
        const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };   // monotone Zeitmessung (die Systemzeit kann beim Start springen)
        const t0 = mono();

        /* ---------- gespeicherte App-Daten (data/dpf.json) ---------- */
        const FILE = path.join(ctx.dataDir, 'dpf.json');
        let store = { log: [], learned: [] };
        try { store = Object.assign(store, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* erster Start */ }
        const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(store)); } catch (e) { log.warn('Speichern von ' + FILE + ': ' + e); } };

        /* ---------- Motorsteuergerät auslesen ---------- */
        const link = new ReadOnlyDiag(ctx.signals, log);
        link.init();                                   // im Hintergrund: die Anzeige darf nicht darauf warten
        const rd = new DidReader(link, { ecu: cfg.ecu });
        const live = {}, at = {}, fail = {}, tryAt = {}, logged = {};
        let histOdo = [], histAt = 0, lastReal = 0;

        /** Antwortbytes einmalig protokollieren, sowohl bei Erfolg als auch beim ersten Fehler. */
        function logRaw(k, c, ok) {
            const key = k + (ok ? ':ok' : ':fail');
            if (logged[key] || !c) return;
            logged[key] = true;
            const r = rd.raws[rd.key(c)];
            log.info('DDE ' + k + ' 22 ' + DidReader.label(c) + ': ' + (r ? r.bytes || r.why : '?') + (ok ? ' -> ' + live[k] : ''));
        }

        async function readKey(k) {
            const list = cfg[k] || [];
            if (!list.length) return;
            // nach drei erfolglosen Abfragen einen Wert erst nach einer Minute erneut anfordern
            if ((fail[k] || 0) >= 3 && mono() - (tryAt[k] || 0) < 60000) return;
            tryAt[k] = mono();
            const v = await rd.value(k, list), c = list[rd.pick[k] || 0];
            if (v === null) { fail[k] = (fail[k] || 0) + 1; logRaw(k, c, false); return; }
            fail[k] = 0; live[k] = v; at[k] = mono(); lastReal = mono();
            logRaw(k, c, true);
        }

        /** Kilometerstände der letzten fünf Regenerationen aus der DDE (neueste zuerst). */
        async function readHistory() {
            const out = [];
            for (const did of cfg.history || []) {
                const v = await rd.value('hist' + did, [{ did, bytes: 4, factor: 0.001, min: 1, max: 2000000 }]);
                if (v !== null) out.push(v);
            }
            histAt = mono();
            if (out.length) histOdo = out;
        }

        let round = 0, pollTimer = null, wantHistory = true, wantSlow = false;
        async function poll() {
            round++;
            try {
                if (settings.get('demo') !== 'on' && link.ready && link.available) {
                    const keys = round % 5 === 1 || wantSlow ? ALL : FAST;
                    wantSlow = false;
                    for (const k of keys) await readKey(k);
                    if (wantHistory || mono() - histAt > 300000) { wantHistory = false; await readHistory(); }
                }
            } catch (e) { log.warn('DDE-Abfrage: ' + e); }
            pollTimer = setTimeout(poll, Math.max(1, settings.get('rate') || 2) * 1000);
        }
        pollTimer = setTimeout(poll, 1500);

        /* ---------- Demo (PC-Vorschau, Emulator, Testgerät) ---------- */
        let demo = null, demoVals = null;
        function demoOn() {
            // Fehlende echte DDE-Werte NIEMALS unbemerkt durch Simulationsdaten ersetzen.
            // Die Simulation muss in den Einstellungen ausdrücklich aktiviert werden.
            return settings.get('demo') === 'on';
        }

        /** Momentaufnahme aller Werte in realen Einheiten (null = kein aktueller Messwert). */
        function data() {
            if (demoOn()) {
                if (!demo) demo = new DemoDpf(threshold());
                if (!demoVals) demoVals = demo.sample();
                return Object.assign({ demo: true }, demoVals);
            }
            demo = null; demoVals = null;
            const out = { demo: false, history: histOdo };
            const fastMax = Math.max(15000, (settings.get('rate') || 2) * 5000);
            ALL.forEach((k) => { out[k] = at[k] && mono() - at[k] < (FAST.indexOf(k) >= 0 ? fastMax : 120000) ? live[k] : null; });
            return out;
        }

        /** Rußmasse (g) beim Regenerationsbeginn: Einstellung, Lernwert oder typischer Wert. */
        function threshold() {
            const s = settings.get('sootMax');
            if (s > 0) return s;
            const L = (store.learned || []).filter(G.isNum);
            return L.length ? L.reduce((a, b) => a + b, 0) / L.length : DEFAULT_THRESHOLD;
        }
        const thresholdSource = () => (settings.get('sootMax') > 0 ? 'eingestellt' : (store.learned || []).length ? 'learned' : 'typical');

        /* ---------- Regenerationen und Messwertverlauf (sekündlich) ---------- */
        let regen = null, snap = data(), lastDist = null, lastTrace = 0;
        let evidence = { mode: 'unknown', request: false };
        const running = () => !!regen && !regen.endedAt && !regen.offSince;
        const trace = [];  // [monotone Zeit in ms, Ruß, Temp. DPF, Temp. Oxikat, Druck, Demo]
        function finish(r, d, how) {
            const entry = {
                date: r.date, sootStart: r.sootStart, sootEnd: d.soot,
                durS: Math.round(((r.endedAt || mono()) - r.t0) / 1000),
                peakT: r.peakT || null, result: how,
                confidence: r.demo ? 'demo' : 'inferred',
            };
            log.info('Regeneration beobachtet: ' + how + ': ' + JSON.stringify(entry));
            if (r.demo) return;
            store.log.unshift(entry);
            store.log.length = Math.min(store.log.length, 30);
            // Einen geschätzten Grenzwert niemals als „bestätigt“ abspeichern.
            save();
            wantHistory = true;
        }
        function tick() {
            if (demo) demoVals = demo.sample();
            const d = snap = data();
            evidence = RegenEvidence.detect(d, trace, mono());
            const active = evidence.mode === 'demo-active' || evidence.mode === 'suspected';
            if (regen && regen.demo !== d.demo) regen = null;
            if (active && !regen) {
                regen = { t0: mono(), date: Date.now(), sootStart: d.soot, peakT: d.tDpf, demo: d.demo };
                log.info((d.demo ? 'demo' : 'inferred') + ' Regeneration beginnt bei ' + G.fmt(d.soot, 1) + ' g');
            } else if (regen && active) {
                delete regen.offSince;
                if (G.isNum(d.tDpf)) regen.peakT = Math.max(regen.peakT || 0, d.tDpf);
                if (!G.isNum(regen.sootStart) && G.isNum(d.soot)) regen.sootStart = d.soot;
            } else if (regen && !regen.endedAt) {
                // Kurze Messausfälle dürfen eine Regeneration nicht in mehrere Ereignisse aufteilen.
                if (!regen.offSince) regen.offSince = mono();
                if (mono() - regen.offSince > (d.demo ? 3000 : 30000)) {
                    regen.endedAt = mono();
                    wantSlow = true;
                }
            }
            if (regen && regen.endedAt) {
                const fresh = d.demo || (at.distSince && at.distSince > regen.endedAt);
                if (fresh || mono() - regen.endedAt > 30000) {
                    const reset = G.isNum(d.distSince) && d.distSince < 2 &&
                        (G.isNum(lastDist) && lastDist > 10 || G.isNum(store.lastDist) && store.lastDist > 10);
                    const burnt = G.isNum(d.soot) && G.isNum(regen.sootStart) && d.soot < regen.sootStart * 0.4;
                    finish(regen, d, reset || burnt ? 'inferred-completed' : 'inferred-ended');
                    if (G.isNum(d.distSince)) lastDist = d.distSince;
                    regen = null;
                }
            }
            // Ein Rücksprung des DDE-Streckenzählers deutet auf ein Ereignis hin,
            // beweist aber nicht dessen Ursache. Als beobachteten Rücksprung kennzeichnen.
            if (!d.demo && G.isNum(d.distSince)) {
                const before = G.isNum(lastDist) ? lastDist : store.lastDist;
                if (!regen && G.isNum(before) && before > 10 && d.distSince < before - 5 && d.distSince < 5) {
                    store.log.unshift({ date: Date.now(), result: 'distance-reset', kmBefore: Math.round(before), confidence: 'inferred' });
                    store.log.length = Math.min(store.log.length, 30);
                    wantHistory = true;
                    save();
                }
                lastDist = d.distSince;
                const distInt = Math.round(d.distSince);
                if (store.lastDist !== distInt) {
                    if (!G.isNum(store.lastDist) || Math.abs(store.lastDist - distInt) >= 5) {
                        store.lastDist = distInt;
                        save();
                    }
                }
            }
            if (mono() - lastTrace >= TRACE_S * 1000) {
                lastTrace = mono();
                trace.push([lastTrace, d.soot, d.tDpf, d.tOxi, d.dp, d.demo]);
                while (trace.length > TRACE_N) trace.shift();
            }
        }
        setInterval(tick, 1000);

        /* ---------- Einheiten und Beschriftungen ---------- */
        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');
        const pad2 = (n) => (n < 10 ? '0' : '') + n;
        const dur = (s) => (G.isNum(s) ? Math.floor(s / 60) + ':' + pad2(Math.floor(s % 60)) : '--');
        const date = (ms) => { const d = new Date(ms); return d.getFullYear() < 2020 ? '--' : pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + '  ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
        const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
        const num = (v, d, unit) => (G.isNum(v) ? v.toFixed(d || 0) + (unit ? ' ' + unit : '') : '--');

        /** Fehlende Werte erklären; die Rohantworten stehen unter Live-Daten und im Protokoll. */
        function why(k) {
            if (snap.demo) return '';
            if (!link.ready) return link.error ? 'Keine Diagnoseverbindung' : 'Verbinde...';
            if (!link.available) return 'Diagnoseverbindung getrennt';
            const r = (cfg[k] || []).map((c) => rd.raws[rd.key(c)]).filter(Boolean);
            if (!r.length) return 'Wird ausgelesen...';
            if (r.every((x) => /NRC (31|11|12)/.test(x.why))) return 'Im Fahrzeug nicht verfügbar';
            if (r.every((x) => x.why === 'no reply')) return 'Keine Antwort – Zündung an?';
            return 'Kein DDE-Messwert verfügbar';
        }

        /** Geschätzte Restkilometer bis zur Rußschwelle anhand der Rußzunahme seit der letzten Regeneration. */
        function kmLeft(d, thr) {
            if (!G.isNum(d.soot) || !G.isNum(d.distSince) || d.distSince < 10 || d.soot < 0.5) return null;
            return Math.max(0, (thr - d.soot) / (d.soot / d.distSince));
        }
        /** Letzte fünf Minuten der Messreihe idx (entweder Demo- oder Fahrzeugdaten). */
        const recent = (idx, conv) => trace.slice(-SPARK_N).filter((p) => p[5] === snap.demo).map((p) => (conv ? conv(p[idx]) : p[idx]));

        /* ---------- Ansichten ---------- */
        function drawOverview(cv, P, d) {
            const thr = threshold(), max = Math.max(10, Math.ceil(thr * 1.25 / 5) * 5);
            // Rußmasse: hervorgehobene Hauptanzeige im BMW-Stil
            ID7.card(cv, P, 40, 46, 750, 196);
            cv.text('Rußmasse', 64, 84, 24, P.text2);
            cv.text(G.isNum(d.soot) ? 'Regeneration ab ca. ' + G.fmt(thr, 0) + ' g (' + thresholdSource() + ')' : why('soot'), 766, 84, 20, P.dim, { align: 'right' });
            ID7.value(cv, P, 64, 136, d.soot, 'g', 46, { decimals: 1 });
            ID7.slantBar(cv, P, 64, 154, 702, 26, { value: d.soot, min: 0, max, mark: thr, zoneFrom: thr });

            // Abgastemperatur vor dem Partikelfilter
            const tMax = F() ? 1500 : 800;
            cv.text('Abgastemperatur vor DPF', 64, 290, 24, P.text2);
            cv.text('Regeneration ab ca. ' + Math.round(T(550)) + ' ' + tU(), 766, 290, 20, P.dim, { align: 'right' });
            ID7.value(cv, P, 64, 342, T(d.tDpf), tU(), 46);
            ID7.slantBar(cv, P, 64, 360, 702, 26, { value: T(d.tDpf), min: 0, max: tMax, zoneFrom: T(550), ticks: 4 });

            // Zusatzzeile wie bei BMW: Strecke, Kraftstoff und durchschnittliches Intervall
            let x = 64;
            const seg = (label, val) => { x += cv.text(label, x, 488, 22, P.dim) + 8; x += cv.text(val, x, 488, 22, P.text2) + 34; };
            seg('Seit Regeneration', num(d.distSince, 0, 'km'));
            seg('Kraftstoff', num(d.fuelSince, 1, 'l'));
            seg('Durchschnitt', num(d.avgInterval, 0, 'km'));

            // Filtergrafik mit Status darunter
            drawDpf(cv, P, 830, 40, { soot: d.soot, sootMax: thr, ash: d.ash, tDpf: d.tDpf, dp: d.dp, regen: running(), T, tUnit: tU() });
            cv.fillRect(830, 404, 730, 1, '#3a3a3a');
            let title, sub, dot = null;
            if (running() && d.demo) {
                title = 'Regeneration läuft'; dot = P.heat;
                sub = 'Seit ' + dur((mono() - regen.t0) / 1000) + ' min – Motor bitte weiterlaufen lassen';
            } else if (running()) {
                title = 'Regeneration vermutet'; dot = P.heat;
                sub = 'Aus Temperatur und Rußverlauf vermutet – nicht von DDE bestätigt';
            } else if (evidence.mode === 'requested') {
                title = 'Regeneration angefordert'; dot = P.warn;
                sub = 'DDE-Anforderung bedeutet nicht, dass sie bereits läuft';
            } else if (!G.isNum(d.soot)) { title = 'Keine Daten'; sub = why('soot'); }
            else if (!d.demo && !G.isNum(d.tDpf)) { title = 'Rußdaten verfügbar'; sub = 'Regenerationsstatus unbekannt – Temperatur fehlt'; }
            else if (d.soot >= thr * 0.9) {
                title = 'Rußgrenze bald erreicht'; dot = P.warn;
                sub = 'Grenze geschätzt – DDE entscheidet selbst über Regeneration';
            } else {
                const left = kmLeft(d, thr);
                title = d.demo ? 'Partikelfilter in Ordnung' : 'Rußmasse unter geschätzter Grenze';
                sub = left === null ? 'Ruß ' + num(d.soot, 1, 'g') + ' / geschätzte Grenze ' + G.fmt(thr, 0) + ' g'
                    : 'Nächste Regeneration geschätzt in ' + thousands(Math.round(left / 10) * 10) + ' km';
            }
            let tx = 846;
            if (dot) { cv.circle(856, 440, 8 + (running() ? 2 * Math.sin(Date.now() / 300) : 0), withAlpha(dot, 0.3)); cv.circle(856, 440, 6, dot); tx = 876; }
            cv.text(title, tx, 450, 28, P.text);
            cv.text(sub, 846, 488, 21, P.dim);
        }

        function drawLive(cv, P, d) {
            if (settings.get('raw')) return drawRaw(cv, P, d);
            const items = [
                { label: 'Rußmasse', value: d.soot, unit: 'g', decimals: 1, history: recent(1), k: 'soot' },
                { label: 'Differenzdruck', value: d.dp, unit: 'mbar', history: recent(4), k: 'dp' },
                { label: 'Vor DPF', value: T(d.tDpf), unit: tU(), history: recent(2, T), k: 'tDpf' },
                { label: 'Vor Oxidationskatalysator', value: T(d.tOxi), unit: tU(), history: recent(3, T), k: 'tOxi' },
            ];
            items.forEach((g, i) => {
                const x = 40 + (i % 2) * 480, y = 52 + Math.floor(i / 2) * 230;
                ID7.stat(cv, P, x, y, 420, Object.assign({ caption: 'Verlauf – letzte 5 Min.', sub: G.isNum(g.value) ? null : why(g.k) }, g));
            });
            cv.fillRect(1004, 52, 1, 440, P.line);
            const rows = [
                ['Ölaschemasse', num(d.ash, 1, 'g')],
                ['Rußmasse (berechnet)', num(d.sootSim, 1, 'g')],
                ['Seit Regeneration', num(d.distSince, 1, 'km')],
                ['Kraftstoff seit Regeneration', num(d.fuelSince, 1, 'l')],
                ['Motorlaufzeit seit Regeneration', G.isNum(d.timeSince) ? (d.timeSince / 3600).toFixed(1) + ' h' : '--'],
                ['Mittleres Intervall', num(d.avgInterval, 0, 'km')],
                ['Strömungswiderstand', num(d.flowRes, 4)],
                ['Reg.-Anforderung (nicht aktiv)', num(d.regenReq, 0)],
                ['Unterbrechungsstatus', num(d.interrupted, 0)],
                ['Sperrstatus', num(d.lock, 0)],
            ];
            rows.forEach((r, i) => ID7.row(cv, P, 1030, 46 + i * 46, 530, 46, r[0], r[1], { size: 21, valueSize: 23 }));
        }

        /** Live-Daten mit Rohantworten: Kennung, Antwortbytes und Messwert. */
        function drawRaw(cv, P, d) {
            cv.text('Motorsteuergerät 0x' + Number(cfg.ecu).toString(16).toUpperCase() + '  -  UDS 22', 56, 72, 22, P.dim);
            const s = link.stats;
            cv.text((link.ready ? link.available ? 'Verbunden' : 'Getrennt' : link.error || 'Verbinde') + '   Anfragen ' + s.sent + '   Antworten ' + s.replies + '   Ohne Antwort ' + s.missed,
                1544, 72, 20, P.dim, { align: 'right' });
            ALL.forEach((k, i) => {
                const c = (cfg[k] || [])[rd.pick[k] || 0], r = c && rd.raws[rd.key(c)], y = 84 + i * 30;
                const v = d[k];
                cv.text(NAMES[k], 56, y + 22, 20, P.text2);
                cv.text(c ? DidReader.label(c) : '--', 560, y + 22, 20, P.dim);
                cv.text(d.demo ? 'demo' : r ? (r.bytes ? r.bytes.split(' ').slice(0, 9).join(' ') : r.why) : 'noch nicht abgefragt', 660, y + 22, 20, P.dim);
                cv.text(G.isNum(v) ? G.fmt(v, Math.abs(v) < 10 && v % 1 ? 3 : 1) + ' ' + (UNITS[k] || '') : '--', 1544, y + 22, 21, G.isNum(v) ? P.text : P.dim, { align: 'right' });
                cv.fillRect(40, y + 29, 1520, 1, P.line);
            });
        }

        function drawHistory(cv, P, d) {
            // beobachtete Ereignisse als zweizeilige Liste
            cv.text('Regenerationen', 56, 72, 22, P.dim);
            const list = (store.log || []).slice();
            if (regen && !regen.demo) list.unshift({ date: regen.date, sootStart: regen.sootStart, durS: ((regen.endedAt || mono()) - regen.t0) / 1000, peakT: regen.peakT, result: regen.endedAt ? 'checking' : 'running' });
            const COL = { 'inferred-completed': P.warn, 'inferred-ended': P.dim, 'distance-reset': P.dim, running: P.heat, checking: P.dim };
            const WORD = { 'inferred-completed': 'Vermutlich abgeschlossen', 'inferred-ended': 'Vermutlich beendet', 'distance-reset': 'Streckenzähler zurückgesetzt', running: 'Regeneration vermutet', checking: 'Beendet, prüfe...', 'not watched': 'Während die App geschlossen war' };
            if (!list.length) {
                cv.text(d.demo ? 'Demo: keine Speicherung' : 'Noch keine Regeneration erfasst', 56, 130, 26, P.text2);
                cv.text('Zum Erfassen die App während der Regeneration öffnen.', 56, 166, 21, P.dim);
            }
            list.slice(0, 6).forEach((e, i) => {
                const sub = (e.result === 'not watched' || e.result === 'distance-reset') ? 'Aus DDE-Zählerrücksprung abgeleitet (unbestätigt)'
                    : 'Ruß ' + num(e.sootStart, 1, 'g') + '   Dauer ' + dur(e.durS) + ' min   Spitze ' + (G.isNum(e.peakT) ? Math.round(T(e.peakT)) + ' ' + tU() : '--');
                ID7.row(cv, P, 40, 84 + i * 70, 880, 70, e.date ? date(e.date) : '--', WORD[e.result] || e.result, { sub, valueColor: COL[e.result] || P.dim, valueSize: 22, focus: i === 0 && e.result === 'running' });
            });

            // DDE-Speicher: vergangene Intervalle als Balken, aktuelles Intervall wächst mit
            cv.fillRect(950, 52, 1, 440, P.line);
            cv.text('DDE-Speicher', 980, 72, 22, P.dim);
            const h = d.history || [];
            const bars = [];
            for (let i = Math.min(h.length - 1, 4) - 1; i >= 0; i--) bars.push({ km: h[i] - h[i + 1], at: h[i] });
            if (G.isNum(d.distSince)) bars.push({ km: d.distSince, now: true });
            const avg = d.avgInterval;
            const top = Math.max(100, ...bars.map((b) => b.km), G.isNum(avg) ? avg : 0) * 1.15;
            const bx = 990, bw = 560, by = 110, bh = 250, slot = bw / Math.max(1, bars.length), base = by + bh;
            cv.fillRect(bx, base, bw, 2, P.scale);
            if (!bars.length) cv.text(d.demo ? '' : why('distSince') || 'Wird ausgelesen...', bx, by + 120, 22, P.dim);
            bars.forEach((b, i) => {
                const cx = bx + slot * i + slot / 2, hh = Math.max(3, (b.km / top) * bh), w = Math.min(64, slot * 0.5);
                if (b.now) {
                    cv.strokeRoundRect(cx - w / 2, base - hh, w, hh, 2, 2, P.accent);
                    cv.fillRect(cx - w / 2 + 2, base - hh + 2, w - 4, hh - 2, withAlpha(P.accent, 0.18));
                } else cv.card(cx - w / 2, base - hh, w, hh, 2, [[0, P.silver[0]], [1, P.silver[3]]]);
                cv.text(thousands(b.km), cx, base - hh - 12, 22, P.text, { align: 'center' });
                cv.text(b.now ? 'Jetzt' : thousands(b.at), cx, base + 30, 18, P.dim, { align: 'center' });
            });
            if (G.isNum(avg) && bars.length) {
                const ay = base - (avg / top) * bh;
                for (let k = bx; k < bx + bw; k += 18) cv.fillRect(k, ay, 10, 2, P.accent);
                cv.text('Durchschnitt ' + thousands(avg) + ' km', bx + bw, ay - 10, 18, P.accent, { align: 'right' });
            }
            ID7.row(cv, P, 970, 410, 590, 44, 'Intervall (km), Kilometerstand am Ende', null, { size: 18 });
            ID7.row(cv, P, 970, 454, 590, 44, 'Ölasche im Filter', num(d.ash, 1, 'g'), { size: 21 });
        }

        /* ---------- Anzeige ---------- */
        let page = 0;
        async function render() {
            const P = ID7.palette(settings.get('accent')), d = snap;
            const cv = ctx.canvas(W, H).clear(P.bg);
            [drawOverview, drawLive, drawHistory][page](cv, P, d);
            if (cv.chrome) {
                // Vollbild: Kopfzeile des Kits mit Registerkarten
                G.frame(cv, P, PAGES, page, [d.demo && { text: 'DEMO' }, running() && { text: 'REGENERATION', color: P.heat }]);
            } else {
                // iDrive-Layout: Das HMI zeigt den Titel oberhalb der Ansicht,
                // Hinweise stehen oben rechts (in der Übersicht direkt im Statusfeld).
                let xr = 1560;
                if (running() && page !== 0) {
                    const s = (d.demo ? 'Demo-Regeneration' : 'Regeneration vermutet') + '  ' + dur((mono() - regen.t0) / 1000);
                    cv.text(s, xr, 30, 20, P.heat, { align: 'right' });
                    xr -= cv.textWidth(s, 20) + 18;
                    cv.circle(xr, 23, 5, P.heat);
                    xr -= 22;
                }
                if (d.demo) ID7.pill(cv, P, xr, 9, 'DEMO');
            }
            return ui.image('MAIN_GFX', cv);
        }
        const go = (i) => { page = i; return render(); };
        BUTTONS.forEach((b, i) => ui.onClick(b, () => go(i)));
        ctx.onTab(go);
        settings.onChange((k) => { if (k === 'sootMax' && demo) demo.thr = threshold(); if (k === 'demo') { regen = null; } });
        // Aktualisierung: 60 Bilder/s mit GPU, sonst 4 Bilder/s (PNG-Ausgabe)
        ctx.loop('MAIN', 4, render);
        tick();
        render().then(() => log.info('Erster Bildaufbau abgeschlossen')).catch((e) => log.warn('Erster Bildaufbau: ' + e));
        void pollTimer;
    },
});
