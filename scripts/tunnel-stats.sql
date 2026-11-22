-- Tunnel telemetry aggregates across all households (#391). Read-only.
-- Run with scripts/tunnel-stats.ps1, or paste into any SQL client (Railway's data tab).
-- Per ISO week (Monday start, UTC) for the last N weeks: N = setting stats.weeks
-- (`SET stats.weeks = 12;`), default 8. Each query repeats the small `t` CTE so it runs alone.
-- A `-- # Title` line names the table below it (the .ps1 prints it).
-- Rows (docs/protocol.md telemetry): reported = bytes_sent IS NOT NULL (the gateway's end
-- report arrived); only then do relay/failure mean anything. failure null on a reported row = up.
-- Never output names, Firebase UIDs, user or tenant ids: counts only. One exception: the
-- "top households by relayed GB" table shows tenant ids (no names), for cost outliers.

-- # Volume
WITH t AS (
  SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND tenant_id <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       count(*)                                  AS tunnels,
       count(DISTINCT tenant_id)                AS households,
       count(DISTINCT gateway_id)               AS gateways,
       count(DISTINCT user_id)                  AS users,
       count(*) FILTER (WHERE user_id IS NULL)  AS tunnels_without_user
FROM t GROUP BY week ORDER BY week;

-- # Route (reported tunnels with a selected pair)
WITH t AS (
  SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND tenant_id <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       count(*)                                                             AS tunnels,
       round(100.0 * count(*) FILTER (WHERE NOT relay) / count(*), 1)     AS direct_pct,
       round(100.0 * count(*) FILTER (WHERE relay) / count(*), 1)         AS relayed_pct,
       round(100.0 * count(*) FILTER (WHERE ipv6) / count(*), 1)          AS ipv6_pct,
       round(100.0 * count(*) FILTER (WHERE protocol = 'udp') / count(*), 1) AS udp_pct,
       round(100.0 * count(*) FILTER (WHERE protocol = 'tcp') / count(*), 1) AS tcp_pct
FROM t
WHERE bytes_sent IS NOT NULL AND local_candidate_type IS NOT NULL
GROUP BY week ORDER BY week;

-- # Candidate pairs (gateway side / browser side, protocol)
WITH t AS (
  SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND tenant_id <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       local_candidate_type || ' / ' || remote_candidate_type AS pair,
       protocol                                             AS protocol,
       count(*)                                               AS tunnels,
       round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY week), 1) AS pct_of_week
FROM t
WHERE bytes_sent IS NOT NULL AND local_candidate_type IS NOT NULL
GROUP BY week, pair, protocol ORDER BY week, tunnels DESC;

-- # Failures (rate over reported tunnels)
WITH t AS (
  SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND tenant_id <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       count(*) FILTER (WHERE bytes_sent IS NOT NULL)                            AS reported,
       count(*) FILTER (WHERE bytes_sent IS NOT NULL AND failure IS NOT NULL)  AS failed,
       round(100.0 * count(*) FILTER (WHERE bytes_sent IS NOT NULL AND failure IS NOT NULL)
             / nullif(count(*) FILTER (WHERE bytes_sent IS NOT NULL), 0), 1)     AS failure_pct,
       count(*) FILTER (WHERE bytes_sent IS NULL)                                AS unreported
FROM t GROUP BY week ORDER BY week;

-- # Top failure reasons (5 per week)
WITH t AS (
  SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND tenant_id <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
), r AS (
  SELECT week, failure AS reason, count(*) AS tunnels,
         row_number() OVER (PARTITION BY week ORDER BY count(*) DESC, failure) AS rank
  FROM t WHERE bytes_sent IS NOT NULL AND failure IS NOT NULL
  GROUP BY week, failure
)
SELECT week, reason, tunnels FROM r WHERE rank <= 5 ORDER BY week, tunnels DESC, reason;

-- # Throughput (kbps, gateway -> client, as the browser measured it)
WITH t AS (
  SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND tenant_id <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       CASE WHEN bytes_sent IS NULL THEN 'unreported' WHEN relay THEN 'relayed' ELSE 'direct' END AS route,
       count(*)                                                                   AS measured,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY throughput_kbps)::numeric) AS median,
       round(percentile_cont(0.1) WITHIN GROUP (ORDER BY throughput_kbps)::numeric) AS p10
FROM t WHERE throughput_kbps IS NOT NULL
GROUP BY week, route ORDER BY week, route;

-- # Usage (GB = sent + received, 10^9 bytes)
WITH t AS (
  SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS week, *
  FROM tunnels
  WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND tenant_id <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT week,
       round(coalesce(sum(bytes_sent + bytes_received), 0) / 1e9, 2)                       AS total_gb,
       round(coalesce(sum(bytes_sent + bytes_received) FILTER (WHERE relay), 0) / 1e9, 2) AS relayed_gb,
       date_trunc('second', percentile_cont(0.5) WITHIN GROUP (ORDER BY ended_at - created_at)) AS median_duration,
       round(100.0 * count(*) FILTER (WHERE ended_at IS NULL) / count(*), 1)                AS no_end_pct,
       round(100.0 * count(*) FILTER (WHERE bytes_sent IS NULL) / count(*), 1)              AS no_bytes_pct
FROM t GROUP BY week ORDER BY week;

-- # Top households by relayed GB (whole window; tenant ids only, for cost outliers)
WITH t AS (
  SELECT * FROM tunnels
  WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - (coalesce(nullif(current_setting('stats.weeks', true), '')::int, 8) - 1) * interval '1 week'
    AND tenant_id <> '01a1f29f-e670-748a-9047-fb9f6886d050' -- the prod smoke's household (#574)
)
SELECT tenant_id                                          AS household,
       count(*)                                            AS relayed_tunnels,
       round(sum(bytes_sent + bytes_received) / 1e9, 2)  AS relayed_gb
FROM t WHERE relay AND bytes_sent IS NOT NULL
GROUP BY tenant_id ORDER BY relayed_gb DESC LIMIT 10;

-- # Fleet (gateway versions, revoked excluded; seen = heartbeat in the last 7 days)
SELECT coalesce(version, '(none yet)')                                      AS version,
       count(*)                                                               AS gateways,
       count(*) FILTER (WHERE last_seen_at >= now() - interval '7 days')      AS seen_7d
FROM gateways WHERE credential_hash IS NOT NULL
GROUP BY version ORDER BY seen_7d DESC, gateways DESC, version;
