using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Auth;

/// Which household (tenant) a request acts in: the one its Header names, else the user's
/// oldest. CurrentTenantId is only set from a membership returned here, never from the
/// header. The one place that reads memberships across tenants (the tenant isn't known
/// yet), always for one user.
public static class Households
{
    public const string Header = "X-StreamIQ-Household";

    /// HttpContext.Items key: the request named a household it can't use → 404.
    public const string Denied = "streamiq.household-denied";

    /// Response header on the 404 for a household the user isn't in, whether it exists
    /// or not: the web app drops its household choice on it, never on any other 404.
    public const string NotMemberHeader = "X-StreamIQ-Not-Member";

    /// Endpoint metadata: works for a user with no household at all. Every other
    /// authenticated endpoint answers such a user like a non-member.
    public static readonly object Optional = new NoHouseholdOk();

    private sealed class NoHouseholdOk;

    public static IQueryable<Membership> Of(StreamIqDbContext db, Guid userId)
    {
        return db.Memberships.IgnoreQueryFilters()
            .Where(m => m.UserId == userId)
            .OrderBy(m => m.CreatedAt).ThenBy(m => m.TenantId);
    }

    public static Task<bool> AnyAsync(StreamIqDbContext db, Guid userId, CancellationToken ct)
    {
        return Of(db, userId).AnyAsync(ct);
    }

    /// The user's membership in tenantId (null: their oldest). Null = not a member.
    public static Task<Membership?> PickAsync(StreamIqDbContext db, Guid userId, Guid? tenantId, CancellationToken ct)
    {
        var q = Of(db, userId);
        return (tenantId is { } t ? q.Where(m => m.TenantId == t) : q).FirstOrDefaultAsync(ct);
    }
}
