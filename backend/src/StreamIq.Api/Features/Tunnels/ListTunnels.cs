using System.Security.Claims;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Tunnels;

/// Tunnels in the request's household (tenant filter): the caller's own, or with
/// `?scope=household` (admin only) every member's plus its userId. The last 30 days,
/// newest first, at most 200. No candidate types or protocol.
public static class ListTunnels
{
    public static readonly TimeSpan Window = TimeSpan.FromDays(30);
    public const int Limit = 200;

    public record Row(Guid Id, DateTimeOffset CreatedAt, DateTimeOffset? EndedAt, Guid GatewayId, string? GatewayName,
        bool Relay, bool Ipv6, long? BytesSent, long? BytesReceived, int? ThroughputKbps, string? Failure,
        string? Use, long? ActiveMs,
        // household scope only; there an absent userId = a deleted account
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Guid? UserId);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/tunnels", async (string? scope, ClaimsPrincipal user, StreamIqDbContext db, CancellationToken ct) =>
        {
            if (scope is not (null or "household"))
            {
                return Results.BadRequest();
            }
            var household = scope == "household";
            if (household && !user.IsInRole(Membership.Admin))
            {
                return Results.Forbid();   // a member: 403
            }
            var me = Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier) ?? throw new InvalidOperationException("authenticated principal without user id"));
            var since = DateTimeOffset.UtcNow - Window;
            // Revoked gateways keep their row (credential nulled), so their tunnels keep the name.
            var rows = await db.Tunnels.Where(t => (household || t.UserId == me) && t.CreatedAt > since)
                .OrderByDescending(t => t.CreatedAt).Take(Limit)
                .Join(db.Gateways, t => t.GatewayId, g => g.Id, (t, g) => new Row(t.Id, t.CreatedAt, t.EndedAt, g.Id, g.Name,
                    t.Relay, t.Ipv6, t.BytesSent, t.BytesReceived, t.ThroughputKbps, t.Failure, t.Use, t.ActiveMs,
                    household ? t.UserId : null))
                .ToListAsync(ct);
            return Results.Ok(rows);
        }).RequireAuthorization();
    }
}
