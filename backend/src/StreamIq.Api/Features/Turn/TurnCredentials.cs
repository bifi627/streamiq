using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace StreamIq.Api.Features.Turn;

/// ICE servers for ONE brokered session, handed out in the broker's `ready` (never
/// from a free-standing endpoint). Prod: Cloudflare mints a fresh credential per
/// session (CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN) and the broker
/// revokes it when the session's socket closes. Dev: coturn's TURN REST scheme
/// (STREAMIQ_TURN_URLS + STREAMIQ_TURN_SECRET), expiry only. Neither: STUN only.
public static class TurnCredentials
{
    /// Backstop for a credential whose revoke never happened (crash, Cloudflare
    /// down). ponytail: must outlast a relayed session, since TURN refreshes need a
    /// valid credential. A relayed session past 4 h drops at its next refresh.
    /// Upgrade path: push fresh servers in-band → pc.setConfiguration.
    public static readonly TimeSpan Ttl = TimeSpan.FromHours(4);

    const string Cloudflare = "https://rtc.live.cloudflare.com/v1/turn/keys";

    static JsonObject Stun()
    {
        return new() { ["urls"] = new JsonArray("stun:stun.l.google.com:19302") };
    }

    public static JsonArray StunOnly()
    {
        return [Stun()];
    }

    /// RevokeUsername is set when the credential can (and must) be revoked at session end.
    public record Issued(JsonArray IceServers, string? RevokeUsername);

    public static async Task<Issued> IssueAsync(IConfiguration cfg, HttpClient http, string label, CancellationToken ct)
    {
        if (cfg["CLOUDFLARE_TURN_KEY_ID"] is { Length: > 0 } keyId)
        {
            using var rq = new HttpRequestMessage(HttpMethod.Post, $"{Cloudflare}/{keyId}/credentials/generate-ice-servers")
            {
                Content = JsonContent.Create(new { ttl = (int)Ttl.TotalSeconds }),
            };
            rq.Headers.Authorization = new("Bearer", cfg["CLOUDFLARE_TURN_API_TOKEN"]);
            using var rs = await http.SendAsync(rq, ct);
            rs.EnsureSuccessStatusCode();
            // Passed through as-is: we trickle ICE, so the browser-blocked :53 URLs
            // only cost a failed candidate.
            var servers = (await rs.Content.ReadFromJsonAsync<IceServersResponse>(ct))?.IceServers
                ?? throw new InvalidOperationException("TURN provider: no iceServers");
            var username = servers.Select(s => (string?)s?["username"]).FirstOrDefault(u => u is not null);
            return new(servers, username);
        }
        if (cfg["STREAMIQ_TURN_URLS"] is { Length: > 0 } urls)
        {
            // TURN REST (coturn --use-auth-secret): username = "<unix expiry>:<label>",
            // credential = base64(HMAC-SHA1(secret, username)).
            var username = $"{DateTimeOffset.UtcNow.Add(Ttl).ToUnixTimeSeconds()}:{label}";
            var credential = Convert.ToBase64String(HMACSHA1.HashData(
                Encoding.UTF8.GetBytes(cfg["STREAMIQ_TURN_SECRET"] ?? ""), Encoding.UTF8.GetBytes(username)));
            var turn = new JsonObject
            {
                ["urls"] = new JsonArray(urls.Split(',').Select(u => (JsonNode?)u).ToArray()),
                ["username"] = username,
                ["credential"] = credential,
            };
            return new([Stun(), turn], null);
        }
        return new(StunOnly(), null);
    }

    record IceServersResponse(JsonArray? IceServers);

    public static async Task RevokeAsync(IConfiguration cfg, HttpClient http, string username, CancellationToken ct)
    {
        using var rq = new HttpRequestMessage(HttpMethod.Post,
            $"{Cloudflare}/{cfg["CLOUDFLARE_TURN_KEY_ID"]}/credentials/{Uri.EscapeDataString(username)}/revoke");
        rq.Headers.Authorization = new("Bearer", cfg["CLOUDFLARE_TURN_API_TOKEN"]);
        using var rs = await http.SendAsync(rq, ct);
        rs.EnsureSuccessStatusCode();
    }
}
