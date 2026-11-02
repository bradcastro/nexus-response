# Nexus Response

One platform that ingests events from any telematics or camera vendor (Motive, Samsara, Geotab, Lytx, Mantis), normalizes them, and gives dispatch, fleets and insurers one view of incidents, roadside, OEM warranty claims and risk. **Demo data only: every fleet, driver, dealer and outbound action is invented or simulated.**

## Live demo

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bradcastro/nexus-webhook/tree/poc-mantis-demo)

Click the button, sign in to Render, and press **Apply** (free plan). In a few minutes you get a public URL. The launcher at `/` links to the Dispatch, Fleet, Insurer and Onboarding portals. Data lives in memory and reseeds on restart; the free plan sleeps after inactivity, so the first load can take about 30 seconds.

Run locally instead: `npm install && npm start`, then open http://localhost:3000. See `docs/DEPLOY.md` and `docs/ARCHITECTURE.md`.

---

# Webhook Receiver (original notes)

Telematics event ingestion layer for the Nexus Response platform.
Receives First Responder and safety events from Motive (and future providers),
classifies them, and queues them for ops validation and dispatch.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Health check |
| POST | `/webhook/motive` | Motive webhook receiver |
| GET | `/api/incidents` | Fetch all incidents (ops dashboard) |
| POST | `/api/incidents/:id/dispatch` | Dispatch an incident |
| POST | `/api/incidents/:id/dismiss` | Dismiss an incident |
| POST | `/test/trigger-event` | Simulate a Motive event (no truck needed) |

---

## Local Setup

```bash
git clone https://github.com/bradcastro/nexus-webhook.git
cd nexus-webhook
npm install
cp .env.example .env
# Edit .env and add your MOTIVE_WEBHOOK_SECRET
node server.js
```

---

## Render Deployment

1. Push this repo to GitHub
2. In Render: New → Web Service → connect this repo
3. Set these values:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** Node
4. Add environment variables in Render dashboard:
   - `MOTIVE_WEBHOOK_SECRET` = your secret from Motive developer portal
5. Deploy — Render gives you a URL like `https://nexus-webhook.onrender.com`
6. Paste that URL into Motive developer portal as your webhook destination:
   `https://nexus-webhook.onrender.com/webhook/motive`

---

## Testing Without a Real Truck

```bash
curl -X POST https://your-render-url.onrender.com/test/trigger-event
```

This fires a simulated harsh brake event from Enterprise, AL.
Check `/api/incidents` to confirm it was received and stored.

---

## Architecture

```
Motive → POST /webhook/motive → verify signature → parse payload
       → classify severity → saveIncident() → return 200

Ops Dashboard → GET /api/incidents → show pending events
             → POST /api/incidents/:id/dispatch → fire notifications
```

Storage defaults to **in-memory** (no setup needed for POC).
Set `DATABASE_URL` in Render environment variables to switch to PostgreSQL.

---

## Build Sequence

- [x] Week 1-2: Webhook receiver + Motive integration
- [ ] Week 3: VIN enrichment via NHTSA API
- [ ] Week 4: Ops validation dashboard (React)
- [ ] Week 5: Dispatch engine + Twilio notifications
- [ ] Week 6: Fleet onboarding portal
