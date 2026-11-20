using System.Security.Claims;
using System.Text.Json.Serialization;
using FirebaseAdmin.Auth;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Members;

/// The request's household members (any member may list): role and joined date from
/// the tenant-filtered memberships, name and email looked up in Firebase at read
/// time and never stored (no PII in our DB). The name is the user's alias
/// (Firebase displayName), or their email for a pre-alias account; the email
/// itself goes only to its owner (admins don't get others' either).
public static class ListMembers
{
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/members", async (StreamIqDbContext db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            var me = Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? throw new InvalidOperationException("authenticated without a user id"));
            var rows = await db.Memberships
                .Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { m.UserId, u.FirebaseUid, m.Role, m.CreatedAt })
                .OrderBy(r => r.CreatedAt).ThenBy(r => r.UserId)
                .ToListAsync(ct);
            var profiles = await Profiles(rows.Select(r => r.FirebaseUid).ToList(), ct);
            return rows.Select(r =>
            {
                var p = profiles.GetValueOrDefault(r.FirebaseUid);
                return new Member(r.UserId, p?.DisplayName ?? p?.Email, r.UserId == me ? p?.Email : null, r.Role, r.CreatedAt);
            });
        }).RequireAuthorization();
    }

    private sealed record Member(
        Guid UserId,
        string? Name,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Email,
        string Role,
        DateTimeOffset JoinedAt);

    // ponytail: one GetUsersAsync call (max 100 uids); page it if a household ever gets that big.
    private static async Task<Dictionary<string, UserRecord>> Profiles(List<string> uids, CancellationToken ct)
    {
        try
        {
            var result = await FirebaseAuth.DefaultInstance.GetUsersAsync(
                uids.Select(u => (UserIdentifier)new UidIdentifier(u)).ToList(), ct);
            return result.Users.ToDictionary(u => u.Uid);
        }
        catch (Exception e) when (e is FirebaseAuthException or HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return [];   // Firebase unreachable: the list still works, without names
        }
    }
}
