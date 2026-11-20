using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Tunnels;

/// Tunnel telemetry, the browser's one part: the gateway → client throughput it
/// measured. The broker writes the row and its end, the gateway its route
/// and bytes. Only the caller's own tunnel; another tenant's row is invisible to the
/// global filter → 404.
public static class EndTunnel
{
    public record Request(int? ThroughputKbps);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPatch("/tunnels/{id:guid}", async (Guid id, Request rq, ClaimsPrincipal user, StreamIqDbContext db, CancellationToken ct) =>
        {
            var me = Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier) ?? throw new InvalidOperationException("authenticated principal without user id"));
            var row = await db.Tunnels.FirstOrDefaultAsync(c => c.Id == id && c.UserId == me, ct);
            if (row is null)
            {
                return Results.NotFound();
            }
            row.ThroughputKbps = rq.ThroughputKbps > 0 ? rq.ThroughputKbps : null;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        }).RequireAuthorization();
    }
}
