using FirebaseAdmin.Auth;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Members;

/// The request's household members (any member may list): role and joined date from
/// the tenant-filtered memberships, name and email looked up in Firebase at read
/// time and never stored (no PII in our DB, #65).
public static class ListMembers
{
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/members", async (StreamIqDbContext db, CancellationToken ct) =>
        {
            var rows = await db.Memberships
                .Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { m.UserId, u.FirebaseUid, m.Role, m.CreatedAt })
                .OrderBy(r => r.CreatedAt).ThenBy(r => r.UserId)
                .ToListAsync(ct);
            var profiles = await Profiles(rows.Select(r => r.FirebaseUid).ToList(), ct);
            return rows.Select(r =>
            {
                var p = profiles.GetValueOrDefault(r.FirebaseUid);
                return new { userId = r.UserId, name = p?.DisplayName, email = p?.Email, role = r.Role, joinedAt = r.CreatedAt };
            });
        }).RequireAuthorization();
    }

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
