// Warranty claim packet (JSON + printable HTML).
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usd = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

function build(inc) {
  const w = inc.warranty;
  if (!w) return null;
  const p = w.claimPacket;
  const dtcs = (inc.diagnostics && inc.diagnostics.dtcs) || [];
  return {
    claimId: w.claimId || null,
    status: p ? p.status : 'not_eligible',
    eligible: !!w.claimEligible,
    generatedAt: new Date().toISOString(),
    oem: w.oem,
    incident: { id: inc.id, eventType: inc.eventType, timestamp: inc.timestamp, provider: inc.provider, providerEventId: inc.providerEventId, status: inc.status },
    claimant: { fleetId: inc.fleetId, fleetName: inc.fleetName },
    vehicle: { ...inc.vehicle, vinDecoded: w.vinDecoded },
    driver: { name: inc.driver.name, phone: inc.driver.phone },
    location: inc.location,
    coverage: { determination: w.claimEligible ? 'covered' : 'not covered', type: w.coverage, reason: w.reason, expiresAt: w.expiresAt, milesRemaining: w.milesRemaining, windows: w.windows },
    failure: dtcs.map((d) => ({ code: d.code, description: d.desc, system: d.system, severity: d.severity, recommendedAction: d.recommendedAction, parts: d.partsHint, estimateUsd: d.estCostUsd })),
    faultLampOn: inc.diagnostics ? inc.diagnostics.faultLampOn : null,
    drivable: inc.diagnostics ? inc.diagnostics.drivable : null,
    summary: p ? p.summary : null,
    evidence: p ? p.evidence : [],
    media: { snapshots: inc.camera.snapshots, clips: inc.camera.clips },
    estimate: p ? { partsAndLaborUsd: p.estimatedValueUsd - (p.towEstimateUsd || 0), towUsd: p.towEstimateUsd || 0, totalUsd: p.estimatedValueUsd, lines: p.laborParts } : null,
    timeline: inc.timeline,
    attestation: 'Data auto-assembled from vendor telematics event, OEM VIN decode and coverage tables by Nexus Response. Subject to OEM review.',
  };
}

function html(pk) {
  const rows = (pk.failure || []).map((f) => `<tr><td>${esc(f.code)}</td><td>${esc(f.description)}</td><td>${esc(f.system)}</td><td>${esc(f.parts)}</td><td class="r">${usd(f.estimateUsd)}</td></tr>`).join('');
  const ev = (pk.evidence || []).map((e) => `<li>${esc(e)}</li>`).join('');
  const v = pk.vehicle;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Warranty Claim ${esc(pk.claimId || pk.incident.id)} - Nexus Response</title>
<style>
body{font:14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;max-width:820px;margin:24px auto;padding:0 20px}
h1{font-size:22px;margin:0}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;border-bottom:2px solid #ff6a1a;padding-bottom:4px;margin:22px 0 8px}
.hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #0b1b33;padding-bottom:10px}
.brand{color:#0b1b33;font-weight:700}.brand b{color:#ff6a1a}.badge{display:inline-block;padding:2px 10px;border-radius:12px;background:#0b1b33;color:#fff;font-size:12px}
.badge.ok{background:#1a7f37}.badge.no{background:#b42318}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d5dd;padding:5px 8px;text-align:left;vertical-align:top}th{background:#f2f4f7}.r{text-align:right}
dl{display:grid;grid-template-columns:150px 1fr;gap:3px 12px;margin:0}dt{color:#555}dd{margin:0}
.tot{font-size:18px;font-weight:700;text-align:right;margin-top:8px}.foot{color:#667085;font-size:12px;margin-top:24px}
@media print{body{margin:0}.noprint{display:none}}
</style></head><body>
<div class="hd"><div><div class="brand">NEXUS <b>RESPONSE</b></div><h1>OEM Warranty Claim Packet</h1></div>
<div style="text-align:right">Claim <b>${esc(pk.claimId || 'n/a')}</b><br><span class="badge ${pk.eligible ? 'ok' : 'no'}">${pk.eligible ? 'COVERED' : 'NOT COVERED'}</span> <span class="badge">${esc(pk.status)}</span></div></div>
<p class="noprint"><a href="#" onclick="window.print();return false">Print / save as PDF</a></p>
<h2>Vehicle</h2><dl><dt>VIN</dt><dd>${esc(v.vin)}</dd><dt>Vehicle</dt><dd>${esc(v.year)} ${esc(v.make)} ${esc(v.model)} (${esc(v.plate)}, unit ${esc(v.unit)})</dd><dt>Engine</dt><dd>${esc(v.engine)}</dd><dt>Odometer</dt><dd>${Math.round(v.odometer_mi || 0).toLocaleString('en-US')} mi</dd><dt>Claimant</dt><dd>${esc(pk.claimant.fleetName)}</dd><dt>OEM</dt><dd>${esc(pk.oem)}</dd></dl>
<h2>Coverage determination</h2><dl><dt>Determination</dt><dd>${esc(pk.coverage.determination)} (${esc(pk.coverage.type)})</dd><dt>Basis</dt><dd>${esc(pk.coverage.reason)}</dd><dt>Expires</dt><dd>${esc(pk.coverage.expiresAt)} / ${(pk.coverage.milesRemaining || 0).toLocaleString('en-US')} mi remaining</dd></dl>
<h2>Failure event</h2><dl><dt>Incident</dt><dd>${esc(pk.incident.id)} - ${esc(pk.incident.eventType)} at ${esc(pk.incident.timestamp)} via ${esc(pk.incident.provider)}</dd><dt>Location</dt><dd>${esc(pk.location.address)} (${pk.location.lat}, ${pk.location.lng})</dd><dt>Driver</dt><dd>${esc(pk.driver.name)}</dd><dt>Drivable</dt><dd>${esc(pk.drivable)}; MIL ${pk.faultLampOn ? 'on' : 'off'}</dd></dl>
<table style="margin-top:8px"><tr><th>Code</th><th>Description</th><th>System</th><th>Parts</th><th>Est.</th></tr>${rows || '<tr><td colspan="5">No fault codes on this event</td></tr>'}</table>
<h2>Summary</h2><p>${esc(pk.summary || 'No claim summary - event is not warranty eligible.')}</p>
<h2>Evidence</h2><ul>${ev || '<li>None</li>'}</ul>
<div class="tot">Estimated claim value: ${usd(pk.estimate ? pk.estimate.totalUsd : 0)}</div>
<p class="foot">${esc(pk.attestation)} Generated ${esc(pk.generatedAt)}.</p></body></html>`;
}
module.exports = { build, html };
