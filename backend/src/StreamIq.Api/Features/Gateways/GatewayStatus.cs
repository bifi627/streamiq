using System.Globalization;
using System.Text.Json.Nodes;

namespace StreamIq.Api.Features.Gateways;

/// The status snapshot a gateway heartbeat carries (#129, docs/protocol.md). The
/// gateway is untrusted input: only known fields survive, each bounded or enum-checked;
/// anything else is dropped. Counts only, never client names (no PII, #65).
public static class GatewayStatus
{
    static readonly string[] Tokens = ["ok", "missing", "legacy"];

    /// Sanitized JSON for the gateways.status column; null when the heartbeat has
    /// no status (older gateway).
    public static string? From(JsonObject m)
    {
        var o = new JsonObject();
        Str(o, "os", m["os"], 20);
        Str(o, "arch", m["arch"], 20);
        Str(o, "update", m["update"], 40);
        if (m["startedAt"] is JsonValue s && s.TryGetValue<string>(out var t)
            && DateTimeOffset.TryParse(t, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var started))
        {
            o["startedAt"] = started.ToUniversalTime();
        }

        Count(o, "pairedClients", m["pairedClients"]);
        Count(o, "activeSessions", m["activeSessions"]);
        if (m["jellyfin"] is JsonObject j)
        {
            var jf = new JsonObject();
            Bool(jf, "reachable", j["reachable"]);
            Str(jf, "version", j["version"], 40);
            Bool(jf, "untested", j["untested"]);
            if (j["token"] is JsonValue tv && tv.TryGetValue<string>(out var token) && Tokens.Contains(token))
            {
                jf["token"] = token;
            }

            o["jellyfin"] = jf;
        }

        return o.Count == 0 ? null : o.ToJsonString();
    }

    static void Str(JsonObject o, string key, JsonNode? n, int max)
    {
        if (n is JsonValue v && v.TryGetValue<string>(out var s) && s.Length is > 0 and var len && len <= max)
        {
            o[key] = s;
        }
    }

    static void Bool(JsonObject o, string key, JsonNode? n)
    {
        if (n is JsonValue v && v.TryGetValue<bool>(out var b))
        {
            o[key] = b;
        }
    }

    static void Count(JsonObject o, string key, JsonNode? n)
    {
        if (n is JsonValue v && v.TryGetValue<int>(out var i) && i is >= 0 and <= 100_000)
        {
            o[key] = i;
        }
    }
}
