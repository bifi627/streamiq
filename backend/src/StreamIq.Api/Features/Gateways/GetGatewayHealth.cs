using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Gateways;

/// A gateway's `gateway_health` rows of the last 7 days, oldest first, led by the latest row
/// before the window (the state it starts in). The browser derives incidents, versions and
/// daily peaks: local days need its time zone. ponytail: raw rows (≤ 288 a day), aggregate in
/// SQL if the response gets heavy.
public static class GetGatewayHealth
{
    public static readonly TimeSpan Window = TimeSpan.FromDays(7);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/gateways/{id:guid}/health", async (Guid id, StreamIqDbContext db, CancellationToken ct) =>
        {
            // The tenant filter: another household's gateway is not found, like an unknown id.
            if (!await db.Gateways.AnyAsync(g => g.Id == id, ct))
            {
                return Results.NotFound();
            }
            var since = DateTimeOffset.UtcNow - Window;
            var rows = db.GatewayHealth.Where(r => r.GatewayId == id);
            var before = await rows.Where(r => r.At < since).OrderByDescending(r => r.At).Take(1).Select(Row).ToListAsync(ct);
            var window = await rows.Where(r => r.At >= since).OrderBy(r => r.At).Select(Row).ToListAsync(ct);
            return Results.Ok(before.Concat(window));
        }).RequireAuthorization();
    }

    public sealed record HealthRow(DateTimeOffset At, bool? JellyfinReachable, string? JellyfinVersion,
        string? GatewayVersion, int? Tunnels, int? Transcodes, double? Cpu, double? Memory);

    static readonly System.Linq.Expressions.Expression<Func<GatewayHealth, HealthRow>> Row = r =>
        new HealthRow(r.At, r.JellyfinReachable, r.JellyfinVersion, r.GatewayVersion, r.Tunnels, r.Transcodes, r.Cpu, r.Memory);
}
