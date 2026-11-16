using System.Security.Claims;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Household;

/// A signed-in user creates a household on purpose and becomes its admin (#387);
/// sign-up makes none. Works with or without a household already. Unnamed until an
/// admin names it (RenameHousehold). One SaveChanges: tenant + membership atomic.
public static class CreateHousehold
{
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost("/households", async (ClaimsPrincipal user, StreamIqDbContext db, CancellationToken ct) =>
        {
            var userId = Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? throw new InvalidOperationException("authenticated principal without user id"));
            var tenant = new Tenant();
            db.Tenants.Add(tenant);
            db.Memberships.Add(new Membership { TenantId = tenant.Id, UserId = userId, Role = Membership.Admin });
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { householdId = tenant.Id });
        }).RequireAuthorization().WithMetadata(Households.Optional)
            .RequireRateLimiting("signaling");   // a flood shield on tenant rows
    }
}
