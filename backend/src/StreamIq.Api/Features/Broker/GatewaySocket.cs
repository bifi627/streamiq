using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;
using StreamIq.Api.Features.Gateways;
using StreamIq.Api.Features.Onboarding;

namespace StreamIq.Api.Features.Broker;

/// The gateway's control socket, authenticated by its credential (Bearer):
/// heartbeats (last_seen_at + advertised LAN URL + version + protocol) and the gateway's half of
/// brokered browser sessions (answer/ice back to the session's browser).
public static class GatewaySocket
{
    /// Oldest gateway protocol (docs/protocol.md) the API still speaks. Raising it is a
    /// deliberate step: every gateway below it is refused until its owner updates.
    public const int MinGatewayProtocol = 1;

    public static void Map(IEndpointRouteBuilder app)
    {
        app.Map("/gateways/ws", async (HttpContext ctx, StreamIqDbContext db) =>
        {
            var header = ctx.Request.Headers.Authorization.ToString();
            var credential = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..].Trim() : "";
            var hash = Secrets.Hash(credential);
            // Tenant-filter exception 2 of 2: the credential establishes the tenant.
            var gateway = credential.Length == 0 ? null
                : await db.Gateways.IgnoreQueryFilters().FirstOrDefaultAsync(d => d.CredentialHash == hash, ctx.RequestAborted);
            if (gateway is null)
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }
            if (!ctx.WebSockets.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }

            db.CurrentTenantId = gateway.TenantId;   // filter live from here on
            using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
            var me = new Broker.Link(socket, gateway.TenantId, gateway.Id);
            var accepted = false;   // registered with the broker only after a heartbeat of a supported protocol
            var ct = ctx.RequestAborted;
            try
            {
                using var limiter = Broker.MessageLimiter(burst: 200, perSecond: 50);
                while (await Broker.ReadAsync(socket, ct, limiter: limiter) is { } msg)
                {
                    switch ((string?)msg["type"])
                    {
                        case "heartbeat":
                            // Missing or not a number = 0 (a gateway from before #176).
                            var protocol = msg["protocol"] is JsonValue pv && pv.TryGetValue<int>(out var p) ? p : 0;
                            if (!accepted)
                            {
                                if (protocol < MinGatewayProtocol)
                                {
                                    // Recorded, so the Gateways list says "update required", not just offline.
                                    await db.Gateways.Where(d => d.Id == gateway.Id)
                                        .ExecuteUpdateAsync(s => s.SetProperty(d => d.Protocol, protocol), ct);
                                    await me.KillAsync("upgrade required");
                                    return;
                                }
                                accepted = true;
                                Broker.Gateways[gateway.Id] = me;   // a reconnect replaces the stale link
                            }
                            var lanUrl = SafeLanUrl((string?)msg["lanUrl"]);
                            var version = (string?)msg["version"] is { Length: <= 40 } v ? v : null;
                            var update = (string?)msg["update"] is { Length: > 0 and <= 40 } u ? u : null;
                            // Matching the hash, not just the id: a socket that authenticated
                            // just before a revoke is closed at its next heartbeat.
                            var live = await db.Gateways.Where(d => d.Id == gateway.Id && d.CredentialHash == hash)
                                .ExecuteUpdateAsync(s => s
                                    .SetProperty(d => d.LastSeenAt, DateTimeOffset.UtcNow)
                                    .SetProperty(d => d.LanUrl, lanUrl)
                                    .SetProperty(d => d.Version, version)
                                    .SetProperty(d => d.Protocol, protocol)
                                    .SetProperty(d => d.Update, update), ct);
                            if (live == 0)
                            {
                                await me.KillAsync("revoked");
                            }
                            break;
                        case "answer" or "ice" when accepted:
                            // Only into sessions opened *for this gateway*: a gateway can't
                            // inject signaling into another gateway's (or tenant's) session.
                            if (Guid.TryParse((string?)msg["session"], out var sid)
                                && Broker.Sessions.TryGetValue(sid, out var browser)
                                && browser.GatewayId == gateway.Id)
                            {
                                await browser.SendAsync(Relay(msg), ct);
                            }

                            break;
                    }
                }
            }
            catch (Exception) { }   // a dropped gateway socket must never crash the process
            finally
            {
                Broker.Gateways.TryRemove(new(gateway.Id, me));
                // Its sessions are dead (a restart takes the pcs with it): close their
                // clients' sockets now instead of letting ICE notice in ~30 s (#172).
                await Task.WhenAll(Broker.Sessions.Values.Where(s => s.Via == me).Select(s => s.KillAsync("gateway gone")));
            }
        }).RequireRateLimiting("signaling");
    }

    // Forward only the fields the protocol defines (docs/protocol.md).
    static JsonObject Relay(JsonObject m)
    {
        return new()
        {
            ["type"] = (string?)m["type"],
            ["sdp"] = m["sdp"]?.DeepClone(),
            ["candidate"] = m["candidate"]?.DeepClone(),
        };
    }

    // The web app renders this as a link: only plain http(s) URLs, never javascript: etc.
    static string? SafeLanUrl(string? s)
    {
        return s is { Length: <= 200 } && Uri.TryCreate(s, UriKind.Absolute, out var u) && u.Scheme is "http" or "https"
            ? u.ToString() : null;
    }
}
