using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Household;

/// An admin names the request's household (#384); until then the web app shows
/// the end of its id. Trimmed, 1–100 characters, no control characters (like a
/// gateway name).
public static class RenameHousehold
{
    public record Request(string? Name);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPut("/households/current/name", async (Request req, StreamIqDbContext db, CancellationToken ct) =>
        {
            var name = req.Name?.Trim();
            if (name is not { Length: > 0 and <= 100 } || name.Any(char.IsControl))
            {
                return Results.BadRequest();
            }
            // CurrentTenantId comes only from the caller's own membership (Auth/Households.cs).
            var tenant = await db.Tenants.FindAsync([db.CurrentTenantId], ct);
            if (tenant is null)
            {
                return Results.NotFound();
            }
            tenant.Name = name;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { name });
        }).RequireAuthorization(p => p.RequireRole(Membership.Admin));   // member: 403
    }
}
