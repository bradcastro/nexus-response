require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const { saveIncident, getIncidents, updateIncidentStatus } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());

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

// ─── Motive Webhook Receiver ──────────────────────────────────────────────────
app.post('/webhook/motive', async (req, res) => {
  try {
    const signature = req.headers['x-motive-signature'] || req.headers['x-webhook-signature'];
    const rawBody = req.body;

    // Verify the webhook came from Motive
    if (process.env.MOTIVE_WEBHOOK_SECRET) {
      const isValid = verifyMotiveSignature(rawBody, signature, process.env.MOTIVE_WEBHOOK_SECRET);
      if (!isValid) {
        console.warn('[NEXUS] Signature verification failed — possible spoofed request');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // Parse the payload
    const payload = JSON.parse(rawBody.toString());
    console.log('[NEXUS] Motive event received:', JSON.stringify(payload, null, 2));

    // Extract and classify the event
    const incident = parseMotivePayload(payload);
    console.log('[NEXUS] Incident classified:', incident.eventType, '| Severity:', incident.severity);

    // Save to database (or in-memory log if no DB configured)
    await saveIncident(incident);

    // Respond immediately — Motive requires a fast 200
    res.status(200).json({ received: true, incidentId: incident.id });

  } catch (err) {
    console.error('[NEXUS] Webhook processing error:', err.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Dashboard API ────────────────────────────────────────────────────────────

// Get all incidents (for the ops dashboard)
app.get('/api/incidents', async (req, res) => {
  try {
    const incidents = await getIncidents();
    res.json({ incidents });
  } catch (err) {
    console.error('[NEXUS] Error fetching incidents:', err.message);
    res.status(500).json({ error: 'Failed to fetch incidents' });
  }
});

// Dispatch an incident
app.post('/api/incidents/:id/dispatch', async (req, res) => {
  try {
    const { id } = req.params;
    await updateIncidentStatus(id, 'dispatched');

    console.log(`[NEXUS] Incident ${id} DISPATCHED`);

    // TODO Week 5: Fire Twilio SMS to provider
    // TODO Week 5: Send fleet manager notification
    // TODO Week 5: Log 911 notification

    res.json({ success: true, incidentId: id, status: 'dispatched' });
  } catch (err) {
    console.error('[NEXUS] Dispatch error:', err.message);
    res.status(500).json({ error: 'Dispatch failed' });
  }
});

// Dismiss an incident
app.post('/api/incidents/:id/dismiss', async (req, res) => {
  try {
    const { id } = req.params;
    await updateIncidentStatus(id, 'dismissed');
    console.log(`[NEXUS] Incident ${id} dismissed`);
    res.json({ success: true, incidentId: id, status: 'dismissed' });
  } catch (err) {
    console.error('[NEXUS] Dismiss error:', err.message);
    res.status(500).json({ error: 'Dismiss failed' });
  }
});

// ─── Test Endpoint (simulate a Motive event without real truck) ───────────────
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
    driver: {
      id: 'DRV-001',
      name: 'Test Driver',
      phone: '+12055550001'
    },
    location: {
      lat: 31.3271,
      lng: -85.8511,
      address: 'I-65 Northbound, Enterprise, AL 36330',
      speed_mph: 62
    },
    videoUrl: null,
    fleetId: 'GOODYEAR-TEST'
  };

  const incident = {
    ...testPayload,
    id: testPayload.id,
    status: 'pending',
    receivedAt: new Date().toISOString()
  };

  await saveIncident(incident);
  console.log('[NEXUS] Test event triggered:', incident.id);
  res.json({ success: true, incident });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function verifyMotiveSignature(rawBody, signature, secret) {
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const expected = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function parseMotivePayload(payload) {
  // Normalize Motive's event structure into Nexus incident format
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
    fleetId: event.fleet_id || null
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
});

module.exports = app;
