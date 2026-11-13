using System.Security.Claims;
using FirebaseAdmin.Auth;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;
using StreamIq.Api.Features.Onboarding;

namespace StreamIq.Api.Features.Invites;

/// Opening an invite link (#191): preview shows which household it is, accept makes
/// the signed-in user a `member` of it. The token establishes the household, so the
/// lookup by hash bypasses the tenant filter (Find); the only row accept ever adds
/// is a membership for the signed-in user in that household.
/// Already a member: no-op (the invite isn't spent). Unknown, revoked, used or
/// expired: 404, all alike. The token travels in the body, never the URL (logs).
public static class AcceptInvite
{
    public record Request(string? Token);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost("/invites/preview", async (Request req, ClaimsPrincipal user, StreamIqDbContext db, CancellationToken ct) =>
        {
            var invite = await Find(db, req.Token, ct);
            if (invite is null)
            {
                return Results.NotFound();
            }
            var member = await Households.PickAsync(db, UserId(user), invite.TenantId, ct) is not null;
            if (!member && (invite.UsedAt is not null || invite.ExpiresAt <= DateTimeOffset.UtcNow))
            {
                return Results.NotFound();
            }
            return Results.Ok(new { householdId = invite.TenantId, name = await NameOf(db, invite, ct), member });
        }).RequireAuthorization();

        app.MapPost("/invites/accept", async (Request req, ClaimsPrincipal user, StreamIqDbContext db, CancellationToken ct) =>
        {
            var invite = await Find(db, req.Token, ct);
            if (invite is null)
            {
                return Results.NotFound();
            }
            var userId = UserId(user);
            if (await Households.PickAsync(db, userId, invite.TenantId, ct) is not null)
            {
                return Results.Ok(new { householdId = invite.TenantId });   // already a member: no-op
            }

            // Conditional UPDATE = single use under races; the membership commits with it.
            var now = DateTimeOffset.UtcNow;
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var claimed = await db.Invites.IgnoreQueryFilters()
                .Where(i => i.Id == invite.Id && i.UsedAt == null && i.ExpiresAt > now)
                .ExecuteUpdateAsync(s => s.SetProperty(i => i.UsedAt, now), ct);
            if (claimed != 1)
            {
                return Results.NotFound();
            }
            db.Memberships.Add(new Membership { TenantId = invite.TenantId, UserId = userId, Role = Membership.Member });
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException)   // joined concurrently (another invite or tab): the PK fired, this invite stays unspent
            {
                return Results.Ok(new { householdId = invite.TenantId });
            }
            await tx.CommitAsync(ct);
            return Results.Ok(new { householdId = invite.TenantId });
        }).RequireAuthorization();
    }

    // Tenant-filter exception: the invite token establishes the household.
    private static Task<Invite?> Find(StreamIqDbContext db, string? token, CancellationToken ct)
    {
        if (token is not { Length: > 0 })
        {
            return Task.FromResult<Invite?>(null);
        }
        var hash = Secrets.Hash(token);
        return db.Invites.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(i => i.TokenHash == hash, ct);
    }

    private static Guid UserId(ClaimsPrincipal user)
    {
        return Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? throw new InvalidOperationException("authenticated principal without user id"));
    }

    // The household's name, else "<inviter>'s household": the inviter's name or email,
    // looked up in Firebase and never stored (no PII in our DB). Null when neither is known.
    private static async Task<string?> NameOf(StreamIqDbContext db, Invite invite, CancellationToken ct)
    {
        var name = await db.Tenants.Where(t => t.Id == invite.TenantId).Select(t => t.Name).SingleAsync(ct);
        if (name is not null)
        {
            return name;
        }
        var uid = await db.Users.Where(u => u.Id == invite.CreatedBy).Select(u => u.FirebaseUid).FirstOrDefaultAsync(ct);
        if (uid is null)
        {
            return null;
        }
        try
        {
            var inviter = await FirebaseAuth.DefaultInstance.GetUserAsync(uid, ct);
            return (inviter.DisplayName ?? inviter.Email) is { Length: > 0 } who ? $"{who}'s household" : null;
        }
        catch (Exception e) when (e is FirebaseAuthException or HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return null;   // inviter gone or Firebase unreachable: the preview still works, unnamed
        }
    }
}
