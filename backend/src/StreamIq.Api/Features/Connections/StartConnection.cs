using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Connections;

/// Connection telemetry, start: the client reports the selected ICE candidate
/// pair once the tunnel is up, or a failed attempt with its reason. Only the caller's own gateways (global filter).
public static class StartConnection
{
    public record Request(Guid GatewayId, bool Relay, bool Ipv6, string? LocalCandidateType,
        string? RemoteCandidateType, string? Protocol, string? Failure = null);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost("/connections", async (Request rq, ClaimsPrincipal user, StreamIqDbContext db, CancellationToken ct) =>
        {
            if (!await db.Gateways.AnyAsync(g => g.Id == rq.GatewayId, ct))
            {
                return Results.NotFound();
            }
            var row = new ConnectionSession
            {
                TenantId = Guid.Parse(user.FindFirstValue("tenant_id") ?? throw new InvalidOperationException("authenticated principal without tenant_id")),
                GatewayId = rq.GatewayId,
                Relay = rq.Relay,
                Ipv6 = rq.Ipv6,
                LocalCandidateType = Clip(rq.LocalCandidateType),
                RemoteCandidateType = Clip(rq.RemoteCandidateType),
                Protocol = Clip(rq.Protocol),
                Failure = Clip(rq.Failure, 64),
            };
            db.ConnectionSessions.Add(row);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { row.Id });
        }).RequireAuthorization().RequireRateLimiting("signaling");
    }

    // Client-supplied strings: keep them short.
    private static string? Clip(string? s, int max = 16)
    {
        return s is { Length: var n } && n > max ? s[..max] : s;
    }
}
