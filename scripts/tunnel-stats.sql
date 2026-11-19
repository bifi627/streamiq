-- Tunnel telemetry aggregates across all households (#391). Read-only.
-- Run with scripts/tunnel-stats.ps1, or paste into any SQL client (Railway's data tab).
-- Per ISO week (Monday start, UTC) for the last N weeks: N = setting stats.weeks
-- (`SET stats.weeks = 12;`), default 8. Each query repeats the small `t` CTE so it runs alone.
-- A `-- # Title` line names the table below it (the .ps1 prints it).
-- Rows (docs/protocol.md "Telemetry"): reported = "BytesSent" IS NOT NULL (the gateway's end
-- report arrived); only then do Relay/Failure mean anything. Failure null on a reported row = up.
-- Never output names, Firebase UIDs, user or tenant ids: counts only. One exception: the
-- "top households by relayed GB" table shows tenant ids (no names), for cost outliers.

-- # Volume
WITH t AS (
  SELECT to_char(date_trunc('week', "CreatedAt" AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE "CreatedAt" >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND "TenantId" <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       count(*)                                  AS tunnels,
       count(DISTINCT "TenantId")                AS households,
       count(DISTINCT "GatewayId")               AS gateways,
       count(DISTINCT "UserId")                  AS users,
       count(*) FILTER (WHERE "UserId" IS NULL)  AS "tunnels without user"
FROM t GROUP BY week ORDER BY week;

-- # Route (reported tunnels with a selected pair)
WITH t AS (
  SELECT to_char(date_trunc('week', "CreatedAt" AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE "CreatedAt" >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND "TenantId" <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       count(*)                                                             AS tunnels,
       round(100.0 * count(*) FILTER (WHERE NOT "Relay") / count(*), 1)     AS "direct %",
       round(100.0 * count(*) FILTER (WHERE "Relay") / count(*), 1)         AS "relayed %",
       round(100.0 * count(*) FILTER (WHERE "Ipv6") / count(*), 1)          AS "ipv6 %",
       round(100.0 * count(*) FILTER (WHERE "Protocol" = 'udp') / count(*), 1) AS "udp %",
       round(100.0 * count(*) FILTER (WHERE "Protocol" = 'tcp') / count(*), 1) AS "tcp %"
FROM t
WHERE "BytesSent" IS NOT NULL AND "LocalCandidateType" IS NOT NULL
GROUP BY week ORDER BY week;

-- # Candidate pairs (gateway side / browser side, protocol)
WITH t AS (
  SELECT to_char(date_trunc('week', "CreatedAt" AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE "CreatedAt" >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND "TenantId" <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       "LocalCandidateType" || ' / ' || "RemoteCandidateType" AS pair,
       "Protocol"                                             AS protocol,
       count(*)                                               AS tunnels,
       round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY week), 1) AS "% of week"
FROM t
WHERE "BytesSent" IS NOT NULL AND "LocalCandidateType" IS NOT NULL
GROUP BY week, pair, protocol ORDER BY week, tunnels DESC;

-- # Failures (rate over reported tunnels)
WITH t AS (
  SELECT to_char(date_trunc('week', "CreatedAt" AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE "CreatedAt" >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND "TenantId" <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       count(*) FILTER (WHERE "BytesSent" IS NOT NULL)                            AS reported,
       count(*) FILTER (WHERE "BytesSent" IS NOT NULL AND "Failure" IS NOT NULL)  AS failed,
       round(100.0 * count(*) FILTER (WHERE "BytesSent" IS NOT NULL AND "Failure" IS NOT NULL)
             / nullif(count(*) FILTER (WHERE "BytesSent" IS NOT NULL), 0), 1)     AS "failure %",
       count(*) FILTER (WHERE "BytesSent" IS NULL)                                AS unreported
FROM t GROUP BY week ORDER BY week;

-- # Top failure reasons (5 per week)
WITH t AS (
  SELECT to_char(date_trunc('week', "CreatedAt" AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE "CreatedAt" >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND "TenantId" <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
), r AS (
  SELECT week, "Failure" AS reason, count(*) AS tunnels,
         row_number() OVER (PARTITION BY week ORDER BY count(*) DESC, "Failure") AS rank
  FROM t WHERE "BytesSent" IS NOT NULL AND "Failure" IS NOT NULL
  GROUP BY week, "Failure"
)
SELECT week, reason, tunnels FROM r WHERE rank <= 5 ORDER BY week, tunnels DESC, reason;

-- # Throughput (kbps, gateway -> client, as the browser measured it)
WITH t AS (
  SELECT to_char(date_trunc('week', "CreatedAt" AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE "CreatedAt" >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND "TenantId" <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       CASE WHEN "BytesSent" IS NULL THEN 'unreported' WHEN "Relay" THEN 'relayed' ELSE 'direct' END AS route,
       count(*)                                                                   AS measured,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY "ThroughputKbps")::numeric) AS median,
       round(percentile_cont(0.1) WITHIN GROUP (ORDER BY "ThroughputKbps")::numeric) AS p10
FROM t WHERE "ThroughputKbps" IS NOT NULL
GROUP BY week, route ORDER BY week, route;

-- # Usage (GB = sent + received, 10^9 bytes)
WITH t AS (
  SELECT to_char(date_trunc('week', "CreatedAt" AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE "CreatedAt" >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND "TenantId" <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       round(coalesce(sum("BytesSent" + "BytesReceived"), 0) / 1e9, 2)                       AS "total GB",
       round(coalesce(sum("BytesSent" + "BytesReceived") FILTER (WHERE "Relay"), 0) / 1e9, 2) AS "relayed GB",
       date_trunc('second', percentile_cont(0.5) WITHIN GROUP (ORDER BY "EndedAt" - "CreatedAt")) AS "median duration",
       round(100.0 * count(*) FILTER (WHERE "EndedAt" IS NULL) / count(*), 1)                AS "no end %",
       round(100.0 * count(*) FILTER (WHERE "BytesSent" IS NULL) / count(*), 1)              AS "no bytes %"
FROM t GROUP BY week ORDER BY week;

-- # Top households by relayed GB (whole window; tenant ids only, for cost outliers)
WITH t AS (
  SELECT * FROM tunnels
  WHERE "CreatedAt" >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND "TenantId" <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT "TenantId"                                          AS household,
       count(*)                                            AS "relayed tunnels",
       round(sum("BytesSent" + "BytesReceived") / 1e9, 2)  AS "relayed GB"
FROM t WHERE "Relay" AND "BytesSent" IS NOT NULL
GROUP BY "TenantId" ORDER BY "relayed GB" DESC LIMIT 10;

-- # Fleet (gateway versions, revoked excluded; seen = heartbeat in the last 7 days)
SELECT coalesce("Version", '(none yet)')                                      AS version,
       count(*)                                                               AS gateways,
       count(*) FILTER (WHERE "LastSeenAt" >= now() - interval '7 days')      AS "seen 7d"
FROM gateways WHERE "CredentialHash" IS NOT NULL
GROUP BY "Version" ORDER BY "seen 7d" DESC, gateways DESC, version;
