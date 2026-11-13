using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Members;

/// An admin promotes a member to admin or demotes an admin (themselves too) to
/// member; takes effect on the target's next request. Demoting the only admin is
/// refused (409). A demoted admin's pending invites stay (see RemoveMember).
public static class SetMemberRole
{
    public record Request(string? Role);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPut("/members/{userId:guid}/role", async (Guid userId, Request req, StreamIqDbContext db, CancellationToken ct) =>
        {
            if (req.Role is not (Membership.Admin or Membership.Member))
            {
                return Results.BadRequest();
            }
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var (m, lastAdmin) = await RemoveMember.LockAsync(db, userId, ct);
            if (m is null)
            {
                return Results.NotFound();
            }
            if (lastAdmin && req.Role == Membership.Member)
            {
                return Results.Conflict(new { error = RemoveMember.LastAdmin });
            }
            m.Role = req.Role;
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return Results.NoContent();
        }).RequireAuthorization(p => p.RequireRole(Membership.Admin));   // member: 403
    }
}
