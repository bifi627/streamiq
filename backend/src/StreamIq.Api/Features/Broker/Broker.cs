using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.RateLimiting;

namespace StreamIq.Api.Features.Broker;

/// Tenant-scoped signaling broker (design: specs/2026-11-01-streamiq-agent-pairing-
/// design.md). Connected gateways by gateway id, live browser sessions by session
/// id. The broker relays SDP/ICE but can't make either side trust the other:
/// pins + pairing do that. ponytail: in-memory, single API instance (Railway);
/// Postgres LISTEN/NOTIFY or Redis when there's a second instance.
public static class Broker
{
    public static readonly ConcurrentDictionary<Guid, Link> Gateways = new();      // gateway id → gateway
    public static readonly ConcurrentDictionary<Guid, Link> Sessions = new();    // session id → browser

    /// One end of a relay. Several readers may write to one socket (many browser
    /// sessions → one gateway), so sends are serialized.
    public sealed class Link(WebSocket socket, Guid tenantId, Guid gatewayId)
    {
        readonly SemaphoreSlim _send = new(1, 1);
        public WebSocket Socket => socket;
        public Guid TenantId => tenantId;
        public Guid GatewayId => gatewayId;

        /// Ends this link from outside its own loop (revocation): a best-effort close
        /// frame (at most 2 s for the send lock + the frame, so a peer that stopped
        /// reading can't stall the caller), then abort. Its reader loop then throws
        /// and runs its normal cleanup.
        public async Task KillAsync(string reason)
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            try
            {
                await _send.WaitAsync(cts.Token);
                try
                {
                    await socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, reason, cts.Token);
                }
                finally
                {
                    _send.Release();
                }
            }
            catch (Exception) { }
            finally
            {
                socket.Abort();
            }
        }

        public async Task SendAsync(JsonNode msg, CancellationToken ct)
        {
            var bytes = Encoding.UTF8.GetBytes(msg.ToJsonString());
            await _send.WaitAsync(ct);
            try
            {
                if (socket.State == WebSocketState.Open)
                {
                    await socket.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
                }
            }
            catch (Exception) { }   // the other end vanished; its own loop cleans up
            finally
            {
                _send.Release();
            }
        }
    }

    /// Per-socket message budget (token bucket). A browser session sends one offer
    /// plus a few dozen ICE candidates; a gateway carries every session of its own.
    public static TokenBucketRateLimiter MessageLimiter(int burst, int perSecond)
    {
        return new(new()
        {
            TokenLimit = burst,
            TokensPerPeriod = perSecond,
            ReplenishmentPeriod = TimeSpan.FromSeconds(1),
            QueueLimit = 0,
        });
    }

    /// Next whole JSON text message, or null when the socket closes. Messages over
    /// max are skipped (SDP is a few KB; 64KB is generous). A message past the
    /// limiter's budget closes the socket (1008 "rate limited") and returns null.
    public static async Task<JsonObject?> ReadAsync(WebSocket socket, CancellationToken ct, int max = 64 * 1024,
        RateLimiter? limiter = null)
    {
        var buffer = new byte[max];
        while (true)
        {
            int n = 0;
            var tooBig = false;
            ValueWebSocketReceiveResult r;
            do
            {
                if (n == buffer.Length)
                {
                    n = 0;
                    tooBig = true;
                }   // keep draining, then drop it
                r = await socket.ReceiveAsync(buffer.AsMemory(n), ct);
                if (r.MessageType == WebSocketMessageType.Close)
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, ct);
                    return null;
                }
                n += r.Count;
            } while (!r.EndOfMessage);
            if (limiter is not null && !limiter.AttemptAcquire().IsAcquired)
            {
                await CloseAsync(socket, "rate limited", ct);
                return null;
            }
            if (tooBig)
            {
                continue;
            }

            try
            {
                if (JsonNode.Parse(buffer.AsSpan(0, n)) is JsonObject o)
                {
                    return o;
                }
            }
            catch (System.Text.Json.JsonException) { }
        }
    }

    /// Close frame only (no waiting for the peer's reply, which a hostile peer
    /// never sends); the handler returning then disposes the socket.
    public static async Task CloseAsync(WebSocket socket, string reason, CancellationToken ct)
    {
        try
        {
            await socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, reason, ct);
        }
        catch (Exception) { }
    }
}
