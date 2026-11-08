# Database backup & recovery

The control plane's Postgres runs on Railway. It holds tenants, users, gateway credential
hashes + DTLS pins, enrollment tokens, and connection telemetry. **Media never touches it.**
Credentials for everything below: `docs/tools.md`.

## What exists

- **Backups are self-hosted.** Railway's scheduled backups need the Pro plan. Instead
  `.github/workflows/db-backup.yml` runs daily at 02:00 UTC (and on manual dispatch: run it
  before a risky migration). It runs `pg_dump -Fc --no-owner --no-privileges` in the
  `postgres:18` image and uploads to
  `gs://<GCS_BACKUP_BUCKET>/<env>/streamiq-<env>-<UTCstamp>.dump`.
- **Environments:** `production` only. When stage exists, add it to the workflow matrix and
  give its GitHub Environment its own `DB_BACKUP_URL`.
- **Retention:** a 30-day delete rule on the bucket (a GCS lifecycle rule, not a script).
- **Restore:** `scripts/restore-db.ps1 -DumpPath <file> -TargetUrl <url> [-Clean]`.
- **RPO ~24 h** (daily dumps). RTO = provision + restore + repoint: minutes at current size.
- The `postgres:18` client must be ≥ the server's major. Bump it in both files with the server.

**What a restore can't bring back:** writes since the last dump. A gateway enrolled after
the dump has no row, so its credential is rejected; re-onboard it (`docs/tools.md` →
Gateway credential). Browser pins and the gateway's allowlist live outside the DB and survive.

## Prerequisites

- Docker running locally (the script uses `postgres:18` as the client).
- `gcloud` signed in with read access to the bucket.
- The target's **`DATABASE_PUBLIC_URL`** (Railway → Postgres service → Variables; TCP proxy
  on; append `?sslmode=require` if missing). The private `DATABASE_URL` isn't reachable
  from your machine.

```powershell
gcloud storage ls gs://streamiq-db-backup/production/ | Sort-Object | Select-Object -Last 1   # newest dump
gcloud storage cp <gs://…dump> .
```

## A: bad migration / wrong data, DB still up

Don't restore over the live DB: restore into a fresh one, verify, then cut over.

1. Railway → the environment → **New → Database → Postgres**. Enable its TCP proxy and copy
   its `DATABASE_PUBLIC_URL`.
2. Pull a dump from **before** the incident.
3. `./scripts/restore-db.ps1 -DumpPath .\streamiq-production-<stamp>.dump -TargetUrl '<new url>'`
4. Verify: `\dt` lists the tables; spot-check row counts (`select count(*) from tenants;`).
5. Cut over: point the backend service's `DATABASE_URL` variable reference at the new
   Postgres. Railway redeploys; the boot-time `MigrateAsync()` is a no-op
   (`__EFMigrationsHistory` came with the dump).
6. Keep the old DB around (not deleted) for ≥24 h as a rollback.
7. Check `/me` and that gateways reconnect (Gateways list shows them online).

## B: total loss (DB deleted, Railway incident)

Same as A without step 6: fresh Postgres → restore the newest dump → repoint
`DATABASE_URL` → redeploy → sign in, open a gateway, play something.

## Restore drill

An untested backup isn't a backup. Do it quarterly and before any major DB change.

**Against the Railway dev DB** (what #44 asked for). This overwrites dev and copies prod's
data (emails, tenant names) into it. Only ever copy prod → dev, never the other way.

```powershell
./scripts/restore-db.ps1 -DumpPath .\streamiq-production-<stamp>.dump -TargetUrl '<dev DATABASE_PUBLIC_URL>' -Clean
```

Then start the backend against dev (`powershell -File scripts/dev.ps1`) and check it boots
and `/me` answers. A dev gateway enrolled against the old dev data has no row any more: re-onboard it.

**Throwaway, no Railway needed:**

```powershell
docker run -d --name drill -e POSTGRES_PASSWORD=drill postgres:18
Start-Sleep 5
docker cp .\drill.dump drill:/drill.dump
docker exec drill pg_restore --no-owner --no-privileges -U postgres -d postgres /drill.dump
docker exec drill psql -U postgres -c '\dt' -c 'select count(*) from tenants' -c 'select count(*) from gateways'
docker rm -f drill
```

Tables listed + non-zero rows = the backup restores. Write the date in the log below.

## Drill log

| Date | Dump | Target | Result |
|---|---|---|---|
