using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Gateways;

/// Rename a gateway (#310). Only the web app's label: the gateway itself never learns it.
public static class RenameGateway
{
    public record Request(string? Name);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPatch("/gateways/{id:guid}", async (Guid id, Request req, StreamIqDbContext db, CancellationToken ct) =>
        {
            var name = req.Name?.Trim();
            if (name is not { Length: >= 1 and <= 100 })   // same bound as enrollment
            {
                return Results.BadRequest();
            }
            // Tenant filter: another household's gateway is 0 rows → 404. Revoked = hidden, as in the list.
            var renamed = await db.Gateways.Where(d => d.Id == id && d.CredentialHash != null)
                .ExecuteUpdateAsync(s => s.SetProperty(d => d.Name, name), ct);
            return renamed == 0 ? Results.NotFound() : Results.NoContent();
        }).RequireAuthorization(p => p.RequireRole(Membership.Admin));   // member: 403
    }
}
