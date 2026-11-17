'use strict';
/**
 * Conservative read-only regeneration evidence.
 * The 44BB "regeneration request" DID is NOT proof of an active regeneration.
 * A true "active" DDE status needs to be found/verified on this vehicle.
 * The real-car mode intentionally returns only "suspected", never "confirmed".
 * Trace columns: [monotonic_ms, soot_g, temp_c, oxidation_temp_c, diff_pressure, demo]
 * Node 8 compatible.
 */
function finite(x) { return typeof x === 'number' && isFinite(x); }
function detect(d, trace, now) {
    if (d.demo) {
        return { mode: finite(d.regenReq) && d.regenReq > 0 ? 'demo-active' : 'idle',
            request: finite(d.regenReq) && d.regenReq > 0, verified: false };
    }
    const request = finite(d.regenReq) && d.regenReq > 0;
    let baseline = null;
    const recent = (trace || []).filter((p) =>
        !p[5] && finite(p[0]) && now - p[0] >= 45000 && now - p[0] <= 180000 && finite(p[1]));
    if (recent.length) baseline = recent[Math.floor(recent.length / 2)][1];
    const drop = finite(baseline) && finite(d.soot) ? baseline - d.soot : null;
    // Two independent indicators: high temperature + sustained soot decrease.
    // This is only an indication; other driving conditions may look similar.
    if (finite(d.tDpf) && d.tDpf >= 530 && finite(drop) && drop >= 0.25) {
        return { mode: 'suspected', request, verified: false, sootDrop: drop };
    }
    return { mode: request ? 'requested' : 'unknown', request, verified: false, sootDrop: drop };
}
module.exports = { detect };
