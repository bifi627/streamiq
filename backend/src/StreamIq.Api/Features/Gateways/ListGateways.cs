using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Gateways;

/// The caller's gateways — auto-scoped by the global tenant filter. No hand-written
/// tenant Where: the filter enforces it.
public static class ListGateways
{
    /// 3 missed 30s gateway heartbeats ⇒ offline.
    public static readonly TimeSpan OnlineWindow = TimeSpan.FromSeconds(90);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/gateways", async (StreamIqDbContext db, CancellationToken ct) =>
        {
            var onlineSince = DateTimeOffset.UtcNow - OnlineWindow;
            // Liveness only (#140): the details come from the gateway API over the tunnel.
            return await db.Gateways.Where(d => d.CredentialHash != null).OrderBy(d => d.CreatedAt)   // revoked = hidden
                .Select(d => new { d.Id, d.Name, d.LastSeenAt, d.LanUrl, d.Version, d.Update, Online = d.LastSeenAt > onlineSince })
                .ToListAsync(ct);
        }).RequireAuthorization();
    }
}
