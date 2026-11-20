using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Tunnels;

/// Per user of the request's household (admin only), over every tunnel of the last 30
/// days, not capped: tunnels, of those the ones Activity hides by default (management or
/// diagnostics that didn't fail), failed ones, and relayed bytes (both directions of every
/// relay row, whatever its use: that's what the relay costs). userId null = deleted accounts.
public static class TunnelSummary
{
    public record Row(Guid? UserId, int Tunnels, int Hidden, int Failed, long RelayedBytes);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/tunnels/summary", async (StreamIqDbContext db, CancellationToken ct) =>
        {
            var since = DateTimeOffset.UtcNow - ListTunnels.Window;
            return await db.Tunnels.Where(t => t.CreatedAt > since)
                .GroupBy(t => t.UserId)
                .OrderByDescending(g => g.Count())
                .Select(g => new Row(g.Key, g.Count(),
                    g.Count(t => (t.Use == "management" || t.Use == "diagnostics") && t.Failure == null),
                    g.Count(t => t.Failure != null),
                    g.Sum(t => t.Relay ? (t.BytesSent ?? 0) + (t.BytesReceived ?? 0) : 0)))
                .ToListAsync(ct);
        }).RequireAuthorization(p => p.RequireRole(Membership.Admin));   // member: 403
    }
}
