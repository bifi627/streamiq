using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Auth;

/// Resolve the StreamIQ user for a Firebase UID, adding the users row on first
/// sign-in. No household comes with it: a user joins one through an invite or
/// creates one on purpose (the Go API: api/internal/household). The firebase_uid
/// UNIQUE constraint settles the concurrent-first-request race.
public class UserProvisioner(StreamIqDbContext db)
{
    public async Task<AppUser> ResolveOrProvisionAsync(string firebaseUid, CancellationToken ct)
    {
        var existing = await db.Users.FirstOrDefaultAsync(u => u.FirebaseUid == firebaseUid, ct);
        if (existing is not null)
        {
            return existing;
        }

        var user = new AppUser { FirebaseUid = firebaseUid };
        db.Users.Add(user);
        try
        {
            await db.SaveChangesAsync(ct);
            return user;
        }
        catch (DbUpdateException)               // lost the race — the unique index fired
        {
            db.ChangeTracker.Clear();
            return await db.Users.FirstAsync(u => u.FirebaseUid == firebaseUid, ct);
        }
    }
}
