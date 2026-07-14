require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { saveIncident, getIncidents, updateIncidentStatus } = require('./db');
const { startPoller } = require('./motive-poller');
const { startSamsaraPoller } = require('./samsara-poller');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Raw body needed for signature verification — MUST come before json parser
app.use('/webhook/motive', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Nexus Response Webhook Receiver',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ─── Config endpoint (serves public keys to frontend) ────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    mapsKey: process.env.GOOGLE_MAPS_KEY || null,
    mapboxToken: process.env.MAPBOX_TOKEN || null
  });
});

// ─── Motive Webhook Receiver ──────────────────────────────────────────────────
app.post('/webhook/motive', async (req, res) => {
  try {
    const signature = req.headers['x-motive-signature'] || req.headers['x-webhook-signature'];
    const rawBody = req.body;

    if (process.env.MOTIVE_WEBHOOK_SECRET) {
      const isValid = verifyMotiveSignature(rawBody, signature, process.env.MOTIVE_WEBHOOK_SECRET);
      if (!isValid) {
        console.warn('[NEXUS] Signature verification failed');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const payload = JSON.parse(rawBody.toString());
    console.log('[NEXUS] Motive webhook received:', JSON.stringify(payload, null, 2));

    const incident = parseMotivePayload(payload);
    await saveIncident(incident);
    res.status(200).json({ received: true, incidentId: incident.id });
  } catch (err) {
    console.error('[NEXUS] Webhook error:', err.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Dashboard API ────────────────────────────────────────────────────────────
app.get('/api/incidents', async (req, res) => {
  try {
    const incidents = await getIncidents();
    res.json({ incidents });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch incidents' });
  }
});

app.post('/api/incidents/:id/dispatch', async (req, res) => {
  try {
    const { id } = req.params;
    await updateIncidentStatus(id, 'dispatched');
    console.log(`[NEXUS] Incident ${id} DISPATCHED`);
    res.json({ success: true, incidentId: id, status: 'dispatched' });
  } catch (err) {
    res.status(500).json({ error: 'Dispatch failed' });
  }
});

app.post('/api/incidents/:id/dismiss', async (req, res) => {
  try {
    const { id } = req.params;
    await updateIncidentStatus(id, 'dismissed');
    console.log(`[NEXUS] Incident ${id} dismissed`);
    res.json({ success: true, incidentId: id, status: 'dismissed' });
  } catch (err) {
    res.status(500).json({ error: 'Dismiss failed' });
  }
});

// ─── Debug — raw incident payload ─────────────────────────────────────────────
app.get('/api/incidents/:id/raw', async (req, res) => {
  try {
    const incidents = await getIncidents();
    const inc = incidents.find(i => i.id === req.params.id);
    if (!inc) return res.status(404).json({ error: 'Not found' });
    res.json({ id: inc.id, rawPayload: inc.rawPayload, videoUrl: inc.videoUrl, snapshots: inc.snapshots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Test Endpoint ────────────────────────────────────────────────────────────
app.post('/test/trigger-event', async (req, res) => {
  const testPayload = {
    id: `test-${Date.now()}`,
    eventType: 'harsh_brake',
    severity: 'high',
    timestamp: new Date().toISOString(),
    vehicle: {
      vin: '1HGBH41JXMN109186',
      make: 'Freightliner',
      model: 'M2 106',
      year: 2021,
      licensePlate: 'AL-GTW-001'
    },
    driver: { id: 'DRV-001', name: 'Test Driver', phone: '+12055550001' },
    location: { lat: 31.3271, lng: -85.8511, address: 'I-65 Northbound, Enterprise, AL 36330', speed_mph: 62 },
    videoUrl: null,
    fleetId: 'GOODYEAR-TEST',
    customerName: 'Goodyear Towing',
    customerLocation: 'Enterprise, AL'
  };
  const incident = { ...testPayload, id: testPayload.id, status: 'pending', receivedAt: new Date().toISOString() };
  await saveIncident(incident);
  console.log('[NEXUS] Test event triggered:', incident.id);
  res.json({ success: true, incident });
});

// ─── Samsara Debug ────────────────────────────────────────────────────────────
app.get('/api/debug/samsara', async (req, res) => {
  const apiKey = process.env.SAMSARA_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SAMSARA_API_KEY not set in Render environment' });

  const results = {};
  const date14 = new Date();
  date14.setDate(date14.getDate() - 14);

  const endpoints = [
    `https://api.samsara.com/fleet/safety-events?startTime=${encodeURIComponent(date14.toISOString())}&endTime=${encodeURIComponent(new Date().toISOString())}`,
    `https://api.samsara.com/fleet/safety-events`,
    `https://api.samsara.com/fleet/vehicles`,
    `https://api.samsara.com/fleet/drivers`,
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text.substring(0, 300); }
      results[url] = {
        status: r.status,
        keys: typeof data === 'object' ? Object.keys(data) : null,
        recordCount: data?.data?.length ?? null,
        sample: JSON.stringify(data).substring(0, 500)
      };
    } catch(e) {
      results[url] = { error: e.message };
    }
  }
  res.json(results);
});

// ─── Motive Safety Debug ──────────────────────────────────────────────────────
app.get('/api/debug/motive-safety-list', async (req, res) => {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key' });

  const results = {};
  const date14 = new Date();
  date14.setDate(date14.getDate() - 14);

  const endpoints = [
    `https://api.gomotive.com/v1/driver_safety_events?per_page=5&start_time=${encodeURIComponent(date14.toISOString())}`,
    `https://api.gomotive.com/v1/driver_safety_events?per_page=5&start_date=${date14.toISOString().split('T')[0]}`,
    `https://api.gomotive.com/v1/driver_safety_events?per_page=5`,
    `https://api.gomotive.com/v2/driver_safety_events?per_page=5`,
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' } });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text.substring(0, 500); }
      results[url] = {
        status: r.status,
        keys: typeof data === 'object' ? Object.keys(data) : null,
        recordCount: Array.isArray(data?.driver_safety_events) ? data.driver_safety_events.length : null,
        videoFields: data?.driver_safety_events?.[0] ? Object.keys(data.driver_safety_events[0]).filter(k =>
          k.includes('video') || k.includes('clip') || k.includes('media') ||
          k.includes('image') || k.includes('camera') || k.includes('snap')) : null,
        sample: JSON.stringify(data).substring(0, 600)
      };
    } catch(e) {
      results[url] = { error: e.message };
    }
  }
  res.json(results);
});

app.get('/api/debug/motive-safety/:eventId', async (req, res) => {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key' });
  const results = {};
  const endpoints = [
    `https://api.gomotive.com/v1/driver_safety_events/${req.params.eventId}`,
    `https://api.gomotive.com/v2/driver_safety_events/${req.params.eventId}`,
    `https://api.gomotive.com/v1/driver_performance_events/${req.params.eventId}`,
  ];
  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: { 'x-api-key': apiKey } });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = text.substring(0, 400); }
      results[url] = { status: r.status, data };
    } catch(e) { results[url] = { error: e.message }; }
  }
  res.json(results);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function verifyMotiveSignature(rawBody, signature, secret) {
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const expected = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch { return false; }
}

function parseMotivePayload(payload) {
  const event = payload.event || payload;
  return {
    id: `NX-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
    source: 'motive',
    rawPayload: payload,
    eventType: event.type || event.event_type || 'unknown',
    severity: classifySeverity(event),
    status: 'pending',
    receivedAt: new Date().toISOString(),
    timestamp: event.occurred_at || event.timestamp || new Date().toISOString(),
    vehicle: {
      vin: event.vehicle?.vin || event.vin || null,
      make: event.vehicle?.make || null,
      model: event.vehicle?.model || null,
      year: event.vehicle?.year || null,
      licensePlate: event.vehicle?.license_plate || null,
      id: event.vehicle?.id || null
    },
    driver: {
      id: event.driver?.id || null,
      name: event.driver?.name || null,
      phone: event.driver?.phone_number || null
    },
    location: {
      lat: event.location?.lat || event.lat || null,
      lng: event.location?.lon || event.location?.lng || event.lon || null,
      address: event.location?.formatted_address || null,
      speed_mph: event.speed_mph || null
    },
    videoUrl: event.video_url || event.dashcam_url || null,
    fleetId: event.fleet_id || null,
    customerName: 'Goodyear Towing',
    customerLocation: 'Enterprise, AL'
  };
}

function classifySeverity(event) {
  const type = (event.type || event.event_type || '').toLowerCase();
  if (type.includes('collision') || type.includes('accident') || type.includes('crash')) return 'critical';
  if (type.includes('rollover') || type.includes('airbag')) return 'critical';
  if (type.includes('harsh_brake') || type.includes('hard_brake')) return 'high';
  if (type.includes('harsh_accel') || type.includes('harsh_turn')) return 'medium';
  if (type.includes('speeding')) return 'low';
  return 'unknown';
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[NEXUS] Server running on port ${PORT}`);
  console.log(`[NEXUS] Webhook endpoint: POST /webhook/motive`);
  console.log(`[NEXUS] Dashboard API:    GET  /api/incidents`);
  console.log(`[NEXUS] Test trigger:     POST /test/trigger-event`);
  startPoller();
  startSamsaraPoller();
});

module.exports = app;
