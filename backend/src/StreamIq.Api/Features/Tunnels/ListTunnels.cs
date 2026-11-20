using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Tunnels;

/// The caller's own tunnels in the request's household (tenant filter + user_id):
/// the last 30 days, newest first, at most 200. No candidate types or protocol.
public static class ListTunnels
{
    public static readonly TimeSpan Window = TimeSpan.FromDays(30);
    public const int Limit = 200;

    public record Row(Guid Id, DateTimeOffset CreatedAt, DateTimeOffset? EndedAt, Guid GatewayId, string? GatewayName,
        bool Relay, bool Ipv6, long? BytesSent, long? BytesReceived, int? ThroughputKbps, string? Failure,
        string? Use, long? ActiveMs);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/tunnels", async (ClaimsPrincipal user, StreamIqDbContext db, CancellationToken ct) =>
        {
            var me = Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier) ?? throw new InvalidOperationException("authenticated principal without user id"));
            var since = DateTimeOffset.UtcNow - Window;
            // Revoked gateways keep their row (credential nulled), so their tunnels keep the name.
            return await db.Tunnels.Where(t => t.UserId == me && t.CreatedAt > since)
                .OrderByDescending(t => t.CreatedAt).Take(Limit)
                .Join(db.Gateways, t => t.GatewayId, g => g.Id, (t, g) => new Row(t.Id, t.CreatedAt, t.EndedAt, g.Id, g.Name,
                    t.Relay, t.Ipv6, t.BytesSent, t.BytesReceived, t.ThroughputKbps, t.Failure, t.Use, t.ActiveMs))
                .ToListAsync(ct);
        }).RequireAuthorization();
    }
}
