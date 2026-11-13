using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Invites;

/// Revoke = delete the pending row: the link then answers like an unknown one. A
/// used invite stays (404: the person already joined). The tenant
/// filter applies to ExecuteDelete, so another household's invite is 0 rows → 404.
public static class RevokeInvite
{
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapDelete("/invites/{id:guid}", async (Guid id, StreamIqDbContext db, CancellationToken ct) =>
            await db.Invites.Where(i => i.Id == id && i.UsedAt == null).ExecuteDeleteAsync(ct) == 0 ? Results.NotFound() : Results.NoContent())
            .RequireAuthorization(p => p.RequireRole(Membership.Admin));   // member: 403
    }
}
