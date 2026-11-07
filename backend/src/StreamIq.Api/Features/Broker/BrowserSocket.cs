using System.Text.Json.Nodes;
using FirebaseAdmin.Auth;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;
using StreamIq.Api.Features.Turn;

namespace StreamIq.Api.Features.Broker;

/// A browser's signaling socket: one WebSocket = one session to one gateway. The
/// Firebase ID token arrives as the first message (not a query param — keeps it
/// out of logs); the offer may only target an online gateway of the caller's tenant.
/// `ready` carries this session's ICE servers; a revocable TURN credential is
/// revoked when the socket closes (closing it also ends the session: `bye`).
public static class BrowserSocket
{
    public static readonly TimeSpan AuthTimeout = TimeSpan.FromSeconds(10);

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
            try
            {
                // Same verify path as the HTTP API (FirebaseAuthHandler), no bypass.
                // An unauthenticated socket gets AuthTimeout to speak, not forever.
                using var authCt = CancellationTokenSource.CreateLinkedTokenSource(ct);
                authCt.CancelAfter(AuthTimeout);
                if (await Broker.ReadAsync(socket, authCt.Token, 8 * 1024) is not { } first || (string?)first["type"] != "auth")
                {
                    await Broker.CloseAsync(socket, "auth first", ct);
                    return;
                }
                AppUser user;
                try
                {
                    var t = await FirebaseAuth.DefaultInstance.VerifyIdTokenAsync((string?)first["token"], ct);
                    user = await provisioner.ResolveOrProvisionAsync(t.Uid, t.Claims.GetValueOrDefault("email") as string, ct);
                }
                catch (Exception)
                {
                    await Broker.CloseAsync(socket, "unauthorized", ct);
                    return;
                }
                db.CurrentTenantId = user.TenantId;
                var me = new Broker.Link(socket, user.TenantId, Guid.Empty);
                JsonArray iceServers;
                try
                {
                    var issued = await TurnCredentials.IssueAsync(cfg, http.CreateClient(), user.Id.ToString(), ct);
                    (iceServers, turnUsername) = (issued.IceServers, issued.RevokeUsername);
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    log.LogWarning(e, "TURN credential issue failed; session gets STUN only");
                    iceServers = TurnCredentials.StunOnly();
                }
                await me.SendAsync(new JsonObject { ["type"] = "ready", ["iceServers"] = iceServers }, ct);

                using var limiter = Broker.MessageLimiter(burst: 50, perSecond: 10);
                while (await Broker.ReadAsync(socket, ct, limiter: limiter) is { } msg)
                {
                    switch ((string?)msg["type"])
                    {
                        case "offer" when gateway is null:
                            // The tenant filter makes another tenant's gateway look absent:
                            // same answer as unknown/offline, so no existence oracle.
                            var ok = Guid.TryParse((string?)msg["gatewayId"], out var gatewayId)
                                && await db.Gateways.AnyAsync(d => d.Id == gatewayId && d.CredentialHash != null, ct)
                                && Broker.Gateways.TryGetValue(gatewayId, out gateway)
                                && gateway.TenantId == user.TenantId;
                            if (!ok || gateway is null)
                            {
                                gateway = null;
                                await me.SendAsync(new JsonObject { ["type"] = "error", ["error"] = "gateway offline or unknown" }, ct);
                                continue;
                            }
                            session = Guid.NewGuid();
                            Broker.Sessions[session] = new Broker.Link(socket, user.TenantId, gatewayId);
                            await gateway.SendAsync(new JsonObject
                            {
                                ["type"] = "offer",
                                ["session"] = session.ToString(),
                                ["sdp"] = msg["sdp"]?.DeepClone(),
                            }, ct);
                            break;
                        case "ice" when gateway is not null:
                            await gateway.SendAsync(new JsonObject
                            {
                                ["type"] = "ice",
                                ["session"] = session.ToString(),
                                ["candidate"] = msg["candidate"]?.DeepClone(),
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
                }
                if (turnUsername is not null)
                {
                    try
                    {
                        await TurnCredentials.RevokeAsync(cfg, http.CreateClient(), turnUsername, CancellationToken.None);
                    }
                    catch (Exception e)
                    {
                        log.LogWarning(e, "TURN credential revoke failed; it expires after {Ttl}", TurnCredentials.Ttl);
                    }
                }
            }
        }).RequireRateLimiting("signaling");
    }
}
