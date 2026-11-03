# Deploying Nexus Response

Runs as a single Node 18+ process. In-memory storage is the default (data resets on restart, perfect for demos). Set `DATABASE_URL` for durable PostgreSQL storage.

## Environment variables
| Var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `DATABASE_URL` | empty (memory) | Postgres connection string; enables durable storage + migrations at boot |
| `DEMO_MODE` | 1 | `1` seeds 7 demo fleets + ~575 incidents (90 days). `0` starts empty (production) and enables legacy pollers |
| `REQUIRE_AUTH` | 0 | `1` rejects webhooks lacking a valid fleet API key (`x-nexus-key` / `Authorization: Bearer nxk_live_...`) or valid vendor HMAC. Set to `1` in production |
| `RATE_LIMIT_PER_MIN` | 1200 | per-client and per-key request budget (batches cost 1 + events/100) |
| `MAX_BATCH_EVENTS` | 5000 | max events per `/webhook/:provider/batch` |
| `MOTIVE_/SAMSARA_/GEOTAB_/LYTX_/MANTIS_/GENERIC_WEBHOOK_SECRET` | empty | HMAC-SHA256 secrets for vendor signature verification (header `x-<vendor>-signature` or `x-webhook-signature`, value `sha256=<hex>`) |
| `TRUST_PROXY` | unset | Set to `1` behind one reverse proxy (Render sets it in render.yaml) so `req.ip` and per-IP rate limits use the real client IP from `X-Forwarded-For`. Leave unset when the app is directly exposed (header would be spoofable) |
| `ENABLE_DEBUG` | 0 | `1` enables `/api/debug/*` and `POST /test/trigger-event` (call third-party APIs with server keys / fire random events). Keep `0` in any shared deployment; they return 404 otherwise |
| `PUBLIC_BASE_URL` | request host | used to render webhook URLs in onboarding |
| `VIN_ONLINE` | 0 | `1` also tries NHTSA vPIC for VINs not in the offline table |
| `ENABLE_LEGACY_POLLERS`, `MOTIVE_API_KEY`, `SAMSARA_API_KEY` | | legacy pollers (only when `DEMO_MODE=0` or enabled explicitly) |

## Production checklist
1. `DEMO_MODE=0`, `REQUIRE_AUTH=1`, `DATABASE_URL=...`, vendor webhook secrets where the vendor supports signing.
2. Create each client: `POST /api/onboarding/fleets` (returns the API key once, the webhook URL and vendor-specific setup steps). Rotate with `POST /api/onboarding/fleets/:id/rotate-key`.
3. Put TLS in front (Render/most PaaS do this). Keep `trust proxy` in mind if you rely on IP rate limits behind a load balancer (set it in `server.js` if needed).
4. Watch `GET /api/ingest/health` (healthy / stale / failing / never_connected per fleet+vendor) and `GET /api/ingest/log?status=rejected` (dead letters); replay with `POST /api/ingest/log/:id/replay`.

## Render
1. New > Web Service > connect the repo. Build command `npm install`, start command `npm start`, Node 18+.
2. New > PostgreSQL (same region); copy its **Internal Database URL** into the service env as `DATABASE_URL`.
3. Add the env vars above (`DEMO_MODE=0`, `REQUIRE_AUTH=1`, secrets). Health check path: `/health`.
4. Deploy. Migrations run automatically on first boot (log lines `migration N applied`). The service also works with free-tier memory mode by omitting `DATABASE_URL`.

## Database
Tables are created by idempotent migrations (`nx_migrations` tracks versions; every statement is `IF NOT EXISTS`, so re-running is safe):
- `incidents_v2` - full canonical incident as JSONB (`data`) plus indexed columns: fleet, status, category, event_type, severity, ts, received_at, provider, provider_event_id (unique per provider = idempotency), source, import_job_id.
- `fleets`, `vehicles`, `drivers`, `providers`, `api_keys` (SHA-256 hash only), `ingest_log` (incl. dead-letter payloads), `import_jobs`, `alerts`, `assessments` - uniform shape `(id, fleet_id, status, ukey, created_at, data JSONB)`.
- Demo rosters regenerate deterministically at boot; onboarded (custom) fleets and their rosters are persisted and restored at boot.
- Bulk imports use chunked multi-row upserts (200 rows per statement).

## Backups
- Render managed Postgres: enable daily backups / point-in-time recovery on the instance plan.
- Manual: `pg_dump "$DATABASE_URL" -Fc -f nexus-$(date +%F).dump`; restore with `pg_restore -d "$DATABASE_URL" --clean nexus-*.dump`.
- API keys are stored hashed; after a restore keep the same hashes valid (no re-issue needed). Raw vendor payloads live in `incidents_v2.data->'raw'` and dead letters in `ingest_log`.

## Limits and notes
- Request body limit 30 MB (imports); single webhook events 1 MB; batches up to 5000 events.
- Import jobs run in-process in chunks; a restart during a job marks it `failed` (re-submit; duplicates are skipped by event id).
- Postgres mode has not been exercised against a live database in this POC build (no local Postgres available); schema/migrations are written to be idempotent and should be verified once on a staging database.
