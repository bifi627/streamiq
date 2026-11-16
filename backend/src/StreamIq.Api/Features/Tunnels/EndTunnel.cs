using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Tunnels;

/// Tunnel telemetry, end: byte totals and the measured gateway → client
/// throughput (#162, optional); duration = EndedAt - CreatedAt.
/// Another tenant's row is invisible to the global filter → 404.
public static class EndTunnel
{
    public record Request(long BytesReceived, long BytesSent, int? ThroughputKbps = null);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPatch("/tunnels/{id:guid}", async (Guid id, Request rq, StreamIqDbContext db, CancellationToken ct) =>
        {
            var row = await db.Tunnels.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (row is null)
            {
                return Results.NotFound();
            }
            row.BytesReceived = rq.BytesReceived;
            row.BytesSent = rq.BytesSent;
            row.ThroughputKbps = rq.ThroughputKbps > 0 ? rq.ThroughputKbps : null;
            row.EndedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        }).RequireAuthorization();
    }
}
