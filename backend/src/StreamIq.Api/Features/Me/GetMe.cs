using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Me;

/// Signed-in user, the household this request acts in, and every household the
/// user belongs to (oldest first). First call for a new Firebase UID provisions
/// tenant+user+membership in the auth handler.
public static class GetMe
{
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/me", async (ClaimsPrincipal user, StreamIqDbContext db, CancellationToken ct) =>
        {
            var userId = Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? throw new InvalidOperationException("authenticated principal without user id"));
            var memberships = await Households.Of(db, userId)
                .Join(db.Tenants, m => m.TenantId, t => t.Id, (m, t) => new { id = t.Id, name = t.Name, role = m.Role })
                .ToListAsync(ct);
            return Results.Ok(new
            {
                userId,
                tenantId = user.FindFirstValue("tenant_id"),
                memberships,
            });
        }).RequireAuthorization();
    }
}
