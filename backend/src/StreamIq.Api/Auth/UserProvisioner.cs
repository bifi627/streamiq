using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Auth;

/// Resolve the StreamIQ user for a Firebase UID, provisioning a tenant + user on
/// first sign-in: a new household with the user as its admin. One SaveChanges =
/// one transaction (tenant + user + membership atomic). The
/// firebase_uid UNIQUE constraint settles the concurrent-first-request race.
public class UserProvisioner(StreamIqDbContext db)
{
    public async Task<AppUser> ResolveOrProvisionAsync(string firebaseUid, CancellationToken ct)
    {
        var existing = await db.Users.FirstOrDefaultAsync(u => u.FirebaseUid == firebaseUid, ct);
        if (existing is not null)
        {
            return existing;
        }

        var tenant = new Tenant();
        db.Tenants.Add(tenant);                 // EF assigns client-generated Guid on Add
        var user = new AppUser { FirebaseUid = firebaseUid };
        db.Users.Add(user);
        db.Memberships.Add(new Membership { TenantId = tenant.Id, UserId = user.Id, Role = Membership.Admin });

        try
        {
            await db.SaveChangesAsync(ct);
            return user;
        }
        catch (DbUpdateException)               // lost the race — the unique index fired
        {
            db.ChangeTracker.Clear();           // drop the rolled-back tenant+user+membership graph
            return await db.Users.FirstAsync(u => u.FirebaseUid == firebaseUid, ct);
        }
    }
}
