using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Gateways;

public static class ListGateways
{
    /// 3 missed 30s gateway heartbeats ⇒ offline.
    public static readonly TimeSpan OnlineWindow = TimeSpan.FromSeconds(90);

    // TODO(#729): one constant with the Go broker's MinGatewayProtocol once the list is ported.
    const int MinGatewayProtocol = 1;

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/gateways", async (StreamIqDbContext db, CancellationToken ct) =>
        {
            var onlineSince = DateTimeOffset.UtcNow - OnlineWindow;
            // Liveness + the telemetry level: the details come from the gateway API over the tunnel.
            return await db.Gateways.Where(d => d.CredentialHash != null).OrderBy(d => d.CreatedAt)   // revoked = hidden
                .Select(d => new
                {
                    d.Id,
                    d.Name,
                    d.LastSeenAt,
                    d.LanUrl,
                    d.Version,
                    d.Update,
                    d.Telemetry,
                    Online = d.LastSeenAt > onlineSince,
                    UpgradeRequired = d.Protocol < MinGatewayProtocol
                })
                .ToListAsync(ct);
        }).RequireAuthorization();
    }
}
