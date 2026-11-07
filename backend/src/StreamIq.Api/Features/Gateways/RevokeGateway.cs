using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Gateways;

/// Remove a gateway: its credential stops working immediately, its live control
/// socket and every session through it are closed. ponytail: revoked = credential
/// hash nulled, row kept, so its connection telemetry survives (rows cascade on a
/// gateway delete). Re-adding the box = delete its state/gateway.json and re-enroll.
public static class RevokeGateway
{
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapDelete("/gateways/{id:guid}", async (Guid id, StreamIqDbContext db, CancellationToken ct) =>
        {
            // The tenant filter applies to ExecuteUpdate: another tenant's gateway is 0 rows → 404.
            var revoked = await db.Gateways.Where(d => d.Id == id && d.CredentialHash != null)
                .ExecuteUpdateAsync(s => s.SetProperty(d => d.CredentialHash, (string?)null), ct);
            if (revoked == 0)
            {
                return Results.NotFound();
            }
            if (Broker.Broker.Gateways.TryRemove(id, out var gateway))
            {
                await gateway.KillAsync("revoked");
            }
            foreach (var (_, session) in Broker.Broker.Sessions.Where(s => s.Value.GatewayId == id))
            {
                await session.KillAsync("gateway revoked");
            }
            return Results.NoContent();
        }).RequireAuthorization();
    }
}
