using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;
using StreamIq.Api.Features.Gateways;
using StreamIq.Api.Features.Onboarding;

namespace StreamIq.Api.Features.Broker;

/// The gateway's control socket, authenticated by its credential (Bearer):
/// heartbeats (last_seen_at + advertised LAN URL + version + protocol) and the gateway's half of
/// brokered browser sessions (answer/ice back to the session's browser), and its
/// report of each tunnel when it ends.
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
            // Tenant-filter exception: the credential establishes the tenant.
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
            try
            {
                await ServeAsync(db, gateway.Id, hash, me, ctx.RequestAborted);
            }
            catch (Exception) { }   // a dropped gateway socket must never crash the process
            finally
            {
                Broker.Gateways.TryRemove(new(gateway.Id, me));
                // Its sessions are dead (a restart takes the pcs with it): close their
                // clients' sockets now instead of letting ICE notice in ~30 s.
                await Task.WhenAll(Broker.Sessions.Values.Where(s => s.Via == me).Select(s => s.KillAsync("gateway gone")));
            }
        }).RequireRateLimiting("signaling");
    }

    // The socket's messages until it closes. Registered with the broker only after a
    // heartbeat of a supported protocol.
    static async Task ServeAsync(StreamIqDbContext db, Guid gatewayId, string hash, Broker.Link me, CancellationToken ct)
    {
        var accepted = false;
        using var limiter = Broker.MessageLimiter(burst: 200, perSecond: 50);
        while (await Broker.ReadAsync(me.Socket, ct, limiter: limiter) is { } msg)
        {
            switch (Broker.Str(msg, "type"))
            {
                case "heartbeat":
                    // The protocol before anything else, so whatever else an old gateway
                    // sends can't keep it from being listed as "update required".
                    var protocol = Heartbeat.ProtocolOf(msg);
                    if (!accepted)
                    {
                        if (protocol < MinGatewayProtocol)
                        {
                            await Heartbeat.StoreRefusedAsync(db, gatewayId, protocol, ct);
                            await me.KillAsync("upgrade required");
                            return;
                        }
                        accepted = true;
                        Broker.Gateways[gatewayId] = me;   // a reconnect replaces the stale link
                    }
                    if (!await Heartbeat.Parse(msg).StoreIfLiveAsync(db, gatewayId, hash, ct))
                    {
                        await me.KillAsync("revoked");
                    }
                    break;
                case "answer" or "ice" when accepted:
                    // Only into sessions opened *for this gateway*: a gateway can't
                    // inject signaling into another gateway's (or tenant's) session.
                    if (Broker.Id(msg, "session") is { } sid
                        && Broker.Sessions.TryGetValue(sid, out var browser)
                        && browser.GatewayId == gatewayId)
                    {
                        await browser.SendAsync(Relay(msg, sid), ct);
                    }
                    break;
                case "tunnel" when accepted:
                    if (TunnelReport.Parse(msg) is { } report)
                    {
                        await report.StoreFirstAsync(db, gatewayId, ct);
                    }
                    break;
            }
        }
    }

    /// A heartbeat (docs/protocol.md), its strings already cleaned for Postgres and the web app.
    internal sealed record Heartbeat(int Protocol, string? LanUrl, string? Version, string? Update, string? Name)
    {
        /// Missing or not a number = 0 (a gateway too old to send it).
        internal static int ProtocolOf(JsonObject m)
        {
            return Broker.Value<int>(m, "protocol") ?? 0;
        }

        internal static Heartbeat Parse(JsonObject m)
        {
            return new(
                ProtocolOf(m),
                SafeLanUrl(Broker.Str(m, "lanUrl")),
                Broker.Str(m, "version") is { Length: <= 40 } v ? v : null,
                Broker.Str(m, "update") is { Length: > 0 and <= 40 } u ? u : null,
                SafeName(Broker.Str(m, "name")));
        }

        /// Recorded, so the Gateways list says "update required", not just offline.
        internal static Task StoreRefusedAsync(StreamIqDbContext db, Guid gatewayId, int protocol, CancellationToken ct)
        {
            return db.Gateways.Where(d => d.Id == gatewayId)
                .ExecuteUpdateAsync(s => s.SetProperty(d => d.Protocol, protocol), ct);
        }

        /// False = the credential was revoked. Matching the hash, not just the id: a socket
        /// that authenticated just before a revoke is closed at its next heartbeat.
        internal async Task<bool> StoreIfLiveAsync(StreamIqDbContext db, Guid gatewayId, string hash, CancellationToken ct)
        {
            var name = Name;
            return await db.Gateways.Where(d => d.Id == gatewayId && d.CredentialHash == hash)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(d => d.LastSeenAt, DateTimeOffset.UtcNow)
                    .SetProperty(d => d.LanUrl, LanUrl)
                    .SetProperty(d => d.Version, Version)
                    .SetProperty(d => d.Protocol, Protocol)
                    .SetProperty(d => d.Update, Update)
                    .SetProperty(d => d.Name, d => name ?? d.Name), ct) > 0;
        }
    }

    /// A gateway's report of one tunnel when it ends; null when malformed.
    internal sealed record TunnelReport(Guid Session, long Sent, long Received, bool Relay, bool Ipv6,
        string? LocalCandidateType, string? RemoteCandidateType, string? Protocol, string? Failure,
        string? Use, long? ActiveMs)
    {
        internal static TunnelReport? Parse(JsonObject m)
        {
            var sent = Broker.Value<long>(m, "bytesSent");
            var received = Broker.Value<long>(m, "bytesReceived");
            if (Broker.Id(m, "session") is not { } session || sent is not >= 0 || received is not >= 0)
            {
                return null;
            }
            return new(session, sent.Value, received.Value,
                Broker.Value<bool>(m, "relay") ?? false,
                Broker.Value<bool>(m, "ipv6") ?? false,
                Clip(Broker.Str(m, "localCandidateType")),
                Clip(Broker.Str(m, "remoteCandidateType")),
                Clip(Broker.Str(m, "protocol")),
                Clip(Broker.Str(m, "failure"), 64),
                Clip(Broker.Str(m, "use")) is { Length: > 0 } use ? use : null,
                Broker.Value<long>(m, "activeMs") is >= 0 and var active ? active : null);
        }

        /// Only this gateway's own row (another gateway's session id changes nothing), only
        /// the first report (BytesSent null = none yet), and also after the browser's socket
        /// closed: the broker's row outlives the session.
        internal Task StoreFirstAsync(StreamIqDbContext db, Guid gatewayId, CancellationToken ct)
        {
            return db.Tunnels.Where(t => t.Id == Session && t.GatewayId == gatewayId && t.BytesSent == null)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(t => t.Relay, Relay)
                    .SetProperty(t => t.Ipv6, Ipv6)
                    .SetProperty(t => t.LocalCandidateType, LocalCandidateType)
                    .SetProperty(t => t.RemoteCandidateType, RemoteCandidateType)
                    .SetProperty(t => t.Protocol, Protocol)
                    .SetProperty(t => t.BytesSent, Sent)
                    .SetProperty(t => t.BytesReceived, Received)
                    .SetProperty(t => t.Failure, Failure)
                    .SetProperty(t => t.Use, Use)
                    .SetProperty(t => t.ActiveMs, ActiveMs), ct);
        }
    }

    // Forward only the fields the protocol defines (docs/protocol.md). The answer
    // tells the browser its tunnel id (the session), for its throughput PATCH.
    static JsonObject Relay(JsonObject m, Guid session)
    {
        var o = new JsonObject
        {
            ["type"] = (string?)m["type"],
            ["sdp"] = m["sdp"]?.DeepClone(),
            ["candidate"] = m["candidate"]?.DeepClone(),
        };
        if ((string?)m["type"] == "answer")
        {
            o["tunnel"] = session.ToString();
        }
        return o;
    }

    // Gateway-supplied strings: keep them short, and only text Postgres takes.
    static string? Clip(string? s, int max = 16)
    {
        if (s is null || s.Any(char.IsControl))
        {
            return null;
        }
        return s.Length <= max ? s : s[..(char.IsHighSurrogate(s[max - 1]) ? max - 1 : max)];
    }

    // The gateway owns its name. Missing or blank (an older gateway) or with a
    // control character (Postgres text refuses NUL) = null: keep the stored name. Cut to
    // 100 UTF-16 units, never between a surrogate pair (Npgsql refuses a lone one).
    internal static string? SafeName(string? s)
    {
        if (s?.Trim() is not { Length: > 0 } n || n.Any(char.IsControl))
        {
            return null;
        }
        return n.Length <= 100 ? n : n[..(char.IsHighSurrogate(n[99]) ? 99 : 100)];
    }

    // The web app renders this as a link: only plain http(s) URLs, never javascript: etc.
    static string? SafeLanUrl(string? s)
    {
        return s is { Length: <= 200 } && Uri.TryCreate(s, UriKind.Absolute, out var u) && u.Scheme is "http" or "https"
            ? u.ToString() : null;
    }
}
