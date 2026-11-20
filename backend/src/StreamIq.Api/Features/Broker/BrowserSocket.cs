using System.Net.WebSockets;
using System.Text.Json.Nodes;
using FirebaseAdmin.Auth;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;
using StreamIq.Api.Features.Turn;

namespace StreamIq.Api.Features.Broker;

/// A browser's signaling socket: one WebSocket = one session to one gateway. The
/// Firebase ID token arrives as the first message (not a query param — keeps it
/// out of logs); the offer may only target an online gateway of a household the
/// caller is a member of (checked for the gateway's tenant, never a household the
/// client names), and the broker stamps the caller's `users.id` on it as `user` and
/// their role in that gateway's household (from the same membership) as `role`.
/// `ready` carries this session's ICE servers; a revocable TURN credential is
/// revoked when the socket closes (closing it also ends the session: `bye`).
/// Telemetry: a routed offer inserts its `tunnels` row (id = session), and the
/// socket closing stamps its end; the gateway's report fills in the rest (GatewaySocket).
public static class BrowserSocket
{
    internal static TimeSpan AuthTimeout = TimeSpan.FromSeconds(10);   // tests shorten it

    public static void Map(IEndpointRouteBuilder app)
    {
        app.Map("/broker/ws", async (HttpContext ctx, StreamIqDbContext db, UserProvisioner provisioner,
            IConfiguration cfg, IHttpClientFactory http, ILogger<Broker.Link> log) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }
            using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
            var ct = ctx.RequestAborted;
            Guid session = Guid.Empty;
            Broker.Link? gateway = null;
            string? turnUsername = null;
            HttpClient? turnHttp = null;
            try
            {
                if (await AuthenticateAsync(socket, db, provisioner, ct) is not { } user)
                {
                    return;
                }
                // Which household: the offer's gateway decides (membership checked there).
                var me = new Broker.Link(socket, Guid.Empty, Guid.Empty);
                // A slow TURN provider must not stall the session: fail fast to STUN.
                turnHttp = http.CreateClient();
                turnHttp.Timeout = TimeSpan.FromSeconds(5);
                JsonArray iceServers;
                (iceServers, turnUsername) = await IceServersAsync(cfg, turnHttp, user, log, ct);
                await me.SendAsync(new JsonObject { ["type"] = "ready", ["iceServers"] = iceServers }, ct);

                using var limiter = Broker.MessageLimiter(burst: 50, perSecond: 10);
                while (await Broker.ReadAsync(socket, ct, limiter: limiter) is { } msg)
                {
                    switch (Broker.Str(msg, "type"))
                    {
                        case "offer" when gateway is null:
                            (session, gateway, var forward) = await OfferAsync(db, user, me, Offer.Parse(msg), log, ct);
                            // Sent only once this handler holds the session: a failed send still
                            // ends it (finally: bye, ended_at, no stale entry in Broker.Sessions).
                            if (gateway is not null && forward is not null)
                            {
                                await gateway.SendAsync(forward, ct);
                            }
                            break;
                        case "ice" when gateway is not null:
                            await gateway.SendAsync(new JsonObject
                            {
                                ["type"] = "ice",
                                ["session"] = session.ToString(),
                                ["candidate"] = Ice.Parse(msg).Candidate?.DeepClone(),
                            }, ct);
                            break;
                    }
                }
            }
            catch (Exception) { }   // a dropped browser socket must never crash the process
            finally
            {
                if (session != Guid.Empty && Broker.Sessions.TryRemove(session, out _) && gateway is not null)
                {
                    await gateway.SendAsync(new JsonObject { ["type"] = "bye", ["session"] = session.ToString() }, CancellationToken.None);
                    try
                    {
                        await db.Tunnels.Where(t => t.Id == session)
                            .ExecuteUpdateAsync(s => s.SetProperty(t => t.EndedAt, DateTimeOffset.UtcNow), CancellationToken.None);
                    }
                    catch (Exception e)
                    {
                        log.LogWarning(e, "tunnel {Session}: end not recorded", session);
                    }
                }
                if (turnUsername is not null && turnHttp is not null)
                {
                    try
                    {
                        await TurnCredentials.RevokeAsync(cfg, turnHttp, turnUsername, CancellationToken.None);
                    }
                    catch (Exception e)
                    {
                        log.LogWarning(e, "TURN credential revoke failed; it expires after {Ttl}", TurnCredentials.Ttl);
                    }
                }
            }
        }).RequireRateLimiting("signaling");
    }

    // Same verify path as the HTTP API (FirebaseAuthHandler), no bypass. An
    // unauthenticated socket gets AuthTimeout to speak, not forever. Null = the socket
    // was closed with the reason. The timeout races the read instead of cancelling it:
    // a cancelled receive aborts the socket, with no close frame to carry the reason.
    static async Task<AppUser?> AuthenticateAsync(WebSocket socket, StreamIqDbContext db,
        UserProvisioner provisioner, CancellationToken ct)
    {
        var read = Broker.ReadAsync(socket, ct, 8 * 1024, strict: true);
        if (await Task.WhenAny(read, Task.Delay(AuthTimeout, ct)) != read)
        {
            // ponytail: the pending read faults when the handler disposes the socket; nobody awaits it.
            await Broker.CloseAsync(socket, "auth timeout", ct);
            return null;
        }
        if (await read is not { } first || Auth.Parse(first) is not { } auth)
        {
            await Broker.CloseAsync(socket, "auth first", ct);
            return null;
        }
        AppUser user;
        try
        {
            var t = await FirebaseAuth.DefaultInstance.VerifyIdTokenAsync(auth.Token, ct);
            user = await provisioner.ResolveOrProvisionAsync(t.Uid, ct);
        }
        catch (Exception)
        {
            await Broker.CloseAsync(socket, "unauthorized", ct);
            return null;
        }
        // In no household at all: nothing to offer to, and no TURN credential for it.
        if (!await Households.AnyAsync(db, user.Id, ct))
        {
            await Broker.CloseAsync(socket, "no household", ct);
            return null;
        }
        return user;
    }

    static async Task<(JsonArray IceServers, string? RevokeUsername)> IceServersAsync(IConfiguration cfg,
        HttpClient turnHttp, AppUser user, ILogger log, CancellationToken ct)
    {
        try
        {
            var issued = await TurnCredentials.IssueAsync(cfg, turnHttp, user.Id.ToString(), ct);
            return (issued.IceServers, issued.RevokeUsername);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)   // incl. the HttpClient timeout
        {
            log.LogWarning(e, "TURN credential issue failed; session gets STUN only");
            return (TurnCredentials.StunOnly(), null);
        }
    }

    // The household is the gateway's tenant, and only if the user is a member of it; the
    // filter then scopes the revocation check to it. Not a member = same answer as
    // unknown/offline (no existence oracle). Returns the new session, its gateway and the
    // offer to send it (the caller sends it), or (Guid.Empty, null, null) after sending the error.
    static async Task<(Guid Session, Broker.Link? Gateway, JsonObject? Forward)> OfferAsync(StreamIqDbContext db, AppUser user,
        Broker.Link me, Offer offer, ILogger log, CancellationToken ct)
    {
        Broker.Link? gateway = null;
        Membership? membership = null;
        var ok = offer.GatewayId is { } gatewayId
            && Broker.Gateways.TryGetValue(gatewayId, out gateway)
            && (membership = await Households.PickAsync(db, user.Id, gateway.TenantId, ct)) is not null;
        if (ok && gateway is not null)
        {
            db.CurrentTenantId = gateway.TenantId;
            ok = await db.Gateways.AnyAsync(d => d.Id == gateway.GatewayId && d.CredentialHash != null, ct);
        }
        if (!ok || gateway is null || membership is null)
        {
            await me.SendAsync(new JsonObject { ["type"] = "error", ["error"] = "gateway offline or unknown" }, ct);
            return (Guid.Empty, null, null);
        }
        var session = Guid.NewGuid();
        // The row exists before the gateway hears of the session, so its report finds it.
        // Best-effort: a failed write costs this tunnel its telemetry, never the tunnel.
        var row = db.Tunnels.Add(new Tunnel { Id = session, TenantId = gateway.TenantId, GatewayId = gateway.GatewayId, UserId = user.Id });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            row.State = EntityState.Detached;
            log.LogWarning(e, "tunnel {Session}: row not recorded", session);
        }
        Broker.Sessions[session] = new Broker.Link(me.Socket, gateway.TenantId, gateway.GatewayId, gateway);
        return (session, gateway, new JsonObject
        {
            ["type"] = "offer",
            ["session"] = session.ToString(),
            // Who acts (users.id, never the Firebase UID); the client key says which device.
            ["user"] = user.Id.ToString(),
            // Their role in the gateway's household, from that same membership lookup.
            ["role"] = membership.Role,
            ["sdp"] = offer.Sdp?.DeepClone(),
        });
    }

    /// The first message; null when it isn't `auth`. A missing token fails verification.
    internal sealed record Auth(string? Token)
    {
        // A log line or a failed test's message must never print the ID token.
        public override string ToString()
        {
            return "Auth { Token = *** }";
        }

        internal static Auth? Parse(JsonObject m)
        {
            return Broker.Str(m, "type") == "auth" ? new(Broker.Str(m, "token")) : null;
        }
    }

    /// A missing or malformed gatewayId reads as null: "gateway offline or unknown".
    /// The SDP is relayed as sent.
    internal sealed record Offer(Guid? GatewayId, JsonNode? Sdp)
    {
        internal static Offer Parse(JsonObject m)
        {
            return new(Broker.Id(m, "gatewayId"), m["sdp"]);
        }
    }

    /// The candidate is relayed as sent.
    internal sealed record Ice(JsonNode? Candidate)
    {
        internal static Ice Parse(JsonObject m)
        {
            return new(m["candidate"]);
        }
    }
}
