-- Relayed bytes per household and month, from Cloudflare's TURN analytics (relay_usage).
-- Read-only: paste into any SQL client as the owner (Railway's data tab). Tenant ids only,
-- never names; the prod smoke's household is left out.
SELECT tenant_id,
       to_char(month, 'YYYY-MM')                        AS month,
       count(DISTINCT gateway_id)                       AS gateways,
       round(sum(bytes) / 1e9, 2)                       AS relayed_gb
FROM relay_usage
WHERE tenant_id <> '01a1f29f-e670-748a-9047-fb9f6886d050'
GROUP BY tenant_id, month
ORDER BY month DESC, relayed_gb DESC;
