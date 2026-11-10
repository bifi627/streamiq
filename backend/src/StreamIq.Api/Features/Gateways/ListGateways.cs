using System.Text.Json.Nodes;
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
            var rows = await db.Gateways.Where(d => d.CredentialHash != null).OrderBy(d => d.CreatedAt)   // revoked = hidden
                .Select(d => new { d.Id, d.Name, d.LastSeenAt, d.LanUrl, d.Version, d.Status, Online = d.LastSeenAt > onlineSince })
                .ToListAsync(ct);
            // Status: the last heartbeat's snapshot (GatewayStatus), kept while offline.
            return rows.Select(d => new
            {
                d.Id,
                d.Name,
                d.LastSeenAt,
                d.LanUrl,
                d.Version,
                d.Online,
                Status = d.Status is null ? null : JsonNode.Parse(d.Status),
            });
        }).RequireAuthorization();
    }
}
