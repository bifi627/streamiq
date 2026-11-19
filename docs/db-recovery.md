# Database backup & recovery

The control plane's Postgres runs on Railway. It holds households (`tenants`), users (pseudonymous
`firebase_uid` only), memberships, invites, gateway credential hashes + DTLS pins,
enrollment tokens, and tunnel telemetry. **Media never touches it.**
Credentials for everything below: `docs/tools.md`.

## What exists

- **Blue/green Postgres.** Two Railway Postgres services: **blue** (the original prod) and
  **green**. One is live, the other is the restore target. GitHub Environment `db-backup`
  (admits only `main`) holds both public URLs (`DB_BLUE_URL`, `DB_GREEN_URL`: the
  `DATABASE_PUBLIC_URL`, TCP proxy on, `?sslmode=require`) and the variable
  **`DB_LIVE` = `<blue|green>/<database>`**, the one fact both workflows read. Today:
  `blue/railway`.
- **Backups are self-hosted.** Railway's scheduled backups need the Pro plan. Instead
  `.github/workflows/db-backup.yml` dumps the `DB_LIVE` database daily at 02:00 UTC (and
  on manual dispatch: run it before a risky migration) with `pg_dump -Fc --no-owner
  --no-privileges` in the `postgres:18` image and uploads it to
  `gs://streamiq/production/streamiq-production-<UTCstamp>.dump`.
- **Restores run in GitHub too.** `.github/workflows/db-restore.yml` downloads a dump (input
  `dump`, empty = the newest) and restores it into a **new** database `restore_<UTC stamp>`
  on the **idle** server, then fails unless `tenants` and `gateways` have rows. It never
  writes into an existing database, so even a wrong `DB_LIVE` can't overwrite live data.
  Its run summary lists the dumps in the bucket.
- **Retention:** a 30-day delete rule on the bucket (a GCS lifecycle rule, not a script).
- **RPO ~24 h** (daily dumps). RTO = restore run + cutover: minutes at current size.
- The `postgres:18` client must be ≥ the server's major. Bump it in both workflows (and
  `scripts/restore-db.ps1`) with the server.
- `scripts/restore-db.ps1 -DumpPath <file> -TargetUrl <url> [-Clean]` restores a dump
  file you have locally (Docker only); the incident path below doesn't need it.

**What a restore can't bring back:** writes since the dump. A gateway enrolled after
the dump has no row, so its credential is rejected; re-onboard it (`docs/tools.md` →
Gateway credential). Browser pins and the gateway's allowlist live outside the DB and survive.

## Incident: restore and cut over

Same steps for "bad migration / wrong data, DB still up" and "DB lost":

1. **DB still up and the data still good up to now?** Run **Database backup** by hand first
   (Actions → Database backup → Run workflow), so the newest dump is from just now. Bad
   data: pick a dump from **before** the incident instead.
2. Actions → **Database restore** → Run workflow; `dump` = that file name (the summary of
   any run lists them), empty = the newest. The run restores into `<idle>/restore_<stamp>`,
   checks it, and keeps it. Its summary names the database and the `gh` command for step 4.
3. **Cut over:** Railway → backend service → Variables → `DATABASE_URL` → point it at the
   idle service and the new database, as a reference:
   `postgresql://${{<idle service>.PGUSER}}:${{<idle service>.PGPASSWORD}}@${{<idle service>.PGHOST}}:${{<idle service>.PGPORT}}/restore_<stamp>`.
   Railway redeploys; the boot-time `MigrateAsync()` is a no-op (`__EFMigrationsHistory`
   came with the dump).
4. **Flip `DB_LIVE`** (the command from the run summary):
   `gh variable set DB_LIVE --env db-backup --body <idle>/restore_<stamp>`. From now on
   the backup dumps the new live database and restores go to the other server. Then run
   **Database backup** by hand and check it names the new database.
5. Check `/me` and that gateways reconnect (Gateways list shows them online).
6. Leave the old database alone for ≥24 h as a rollback (rollback = steps 3 + 4 back to
   it). After that, drop it only if it is a `restore_*` database; a service's own
   `railway` database always stays.

Leftover `restore_*` databases from manual runs stay until dropped by hand
(`drop database restore_<stamp>` on the idle server, e.g. in Railway's data tab). A drill
drops its own, also when it fails.

## Restore drill

An untested backup isn't a backup. **Database restore** runs weekly (Mondays 04:00 UTC) as
the drill: newest dump → new database on the idle server → rows checked → database dropped.
A red run means the backup doesn't restore. Before a major DB change, run it by hand too
and drop the database it keeps.

## Drill log

Manual drills and incidents (the weekly runs are their own log under Actions).

| Date | Dump | Target | Result |
|---|---|---|---|
| 2026-11-19 | fresh `pg_dump` of blue (stand-in for GCS) | green/`restore_20261119t210529` + `…210556`: `db-restore.yml`'s script run locally before merge (drill + manual mode), then `db-backup.yml`'s against `DB_LIVE=green/restore_20261119t210556` | Restored, 3 tenants / 43 gateways; the backup dumped the green database; both dropped |
