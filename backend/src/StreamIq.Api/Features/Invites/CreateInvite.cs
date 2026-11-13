using System.Security.Claims;
using StreamIq.Api.Data;
using StreamIq.Api.Features.Onboarding;

namespace StreamIq.Api.Features.Invites;

/// An admin mints an invite for the request's household. The plaintext token goes
/// back once (the web app puts it in the link); only its hash is stored.
public static class CreateInvite
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(7);

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost("/invites", async (ClaimsPrincipal user, StreamIqDbContext db, CancellationToken ct) =>
        {
            var token = Secrets.New(16);   // 128 bit
            var invite = new Invite
            {
                TenantId = db.CurrentTenantId ?? throw new InvalidOperationException("authenticated request without a household"),
                TokenHash = Secrets.Hash(token),
                CreatedBy = Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)
                    ?? throw new InvalidOperationException("authenticated principal without user id")),
                ExpiresAt = DateTimeOffset.UtcNow + Lifetime,
            };
            db.Invites.Add(invite);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { invite.Id, token, invite.ExpiresAt });
        }).RequireAuthorization(p => p.RequireRole(Membership.Admin));   // member: 403
    }
}
