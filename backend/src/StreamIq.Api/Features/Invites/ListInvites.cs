using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Invites;

/// The household's pending invites (unused, unexpired), scoped by the tenant filter.
/// ponytail: used/expired rows stay in the table; prune them if it ever matters.
public static class ListInvites
{
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/invites", async (StreamIqDbContext db, CancellationToken ct) =>
        {
            var now = DateTimeOffset.UtcNow;
            return await db.Invites.Where(i => i.UsedAt == null && i.ExpiresAt > now)
                .OrderBy(i => i.CreatedAt)
                .Select(i => new { i.Id, i.CreatedAt, i.ExpiresAt })
                .ToListAsync(ct);
        }).RequireAuthorization(p => p.RequireRole(Membership.Admin));   // member: 403
    }
}
