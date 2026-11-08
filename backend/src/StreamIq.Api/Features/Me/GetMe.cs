using System.Security.Claims;

namespace StreamIq.Api.Features.Me;

/// Signed-in user + their tenant. First call for a new Firebase UID provisions
/// tenant+user in the auth handler.
public static class GetMe
{
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/me", (ClaimsPrincipal user) => Results.Ok(new
        {
            userId = user.FindFirstValue(ClaimTypes.NameIdentifier),
            tenantId = user.FindFirstValue("tenant_id"),
        })).RequireAuthorization();
    }
}
