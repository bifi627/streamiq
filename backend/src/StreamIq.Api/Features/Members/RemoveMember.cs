using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Members;

/// An admin removes a member; anyone removes themselves (= leave). Access ends with
/// the membership: every request and broker offer looks it up afresh. Refused (409)
/// when it would leave the household without an admin. The removed user's pending
/// invites go too, so a link they kept can't bring them back.
/// (A demoted admin's stay: still a member, and the admins see and revoke them.)
public static class RemoveMember
{
    public const string LastAdmin = "A household needs at least one admin. Make someone else admin first.";

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapDelete("/members/{userId:guid}", async (Guid userId, ClaimsPrincipal user, StreamIqDbContext db, CancellationToken ct) =>
        {
            var self = user.FindFirstValue(ClaimTypes.NameIdentifier) == userId.ToString();
            if (!self && !user.IsInRole(Membership.Admin))
            {
                return Results.Forbid();
            }
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var (m, lastAdmin) = await LockAsync(db, userId, ct);
            if (m is null)
            {
                return Results.NotFound();
            }
            if (lastAdmin)
            {
                return Results.Conflict(new { error = LastAdmin });
            }
            db.Memberships.Remove(m);
            await db.SaveChangesAsync(ct);
            await db.Invites.Where(i => i.CreatedBy == userId && i.UsedAt == null).ExecuteDeleteAsync(ct);
            await tx.CommitAsync(ct);
            return Results.NoContent();
        }).RequireAuthorization();
    }

    /// Inside a transaction: lock the household's tenant row, so membership changes in
    /// one household run one at a time (two admins demoting each other can't both pass
    /// the check), then the member (tenant-filtered: another household's is null) and
    /// whether they are its only admin.
    public static async Task<(Membership?, bool LastAdmin)> LockAsync(StreamIqDbContext db, Guid userId, CancellationToken ct)
    {
        var tenant = db.CurrentTenantId ?? throw new InvalidOperationException("authenticated request without a household");
        await db.Tenants.Where(t => t.Id == tenant).ExecuteUpdateAsync(s => s.SetProperty(t => t.Name, t => t.Name), ct);
        var m = await db.Memberships.FirstOrDefaultAsync(x => x.UserId == userId, ct);
        var lastAdmin = m?.Role == Membership.Admin
            && await db.Memberships.CountAsync(x => x.Role == Membership.Admin, ct) == 1;
        return (m, lastAdmin);
    }
}
