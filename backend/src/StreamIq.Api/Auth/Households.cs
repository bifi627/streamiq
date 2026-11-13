using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Auth;

/// Which household (tenant) a request acts in. A user can belong to several; the
/// request names one in the `X-StreamIQ-Household` header, else it gets the user's
/// oldest. CurrentTenantId is only ever set from a membership returned here, never
/// from the header itself. This is the one place that reads memberships across
/// tenants (the filter can't apply: the tenant isn't known yet), always for one user.
public static class Households
{
    public const string Header = "X-StreamIQ-Household";

    /// HttpContext.Items key: the request named a household it can't use → 404.
    public const string Denied = "streamiq.household-denied";

    /// The 404 body's `error` for a household the user isn't in, whether it exists or
    /// not: the web app drops its household choice on it, never on any other 404 (#210).
    public const string NotMember = "not-a-member";

    /// All of the user's memberships, oldest first.
    public static IQueryable<Membership> Of(StreamIqDbContext db, Guid userId)
    {
        return db.Memberships.IgnoreQueryFilters()
            .Where(m => m.UserId == userId)
            .OrderBy(m => m.CreatedAt).ThenBy(m => m.TenantId);
    }

    /// Whether the user belongs to any household at all.
    public static Task<bool> AnyAsync(StreamIqDbContext db, Guid userId, CancellationToken ct)
    {
        return Of(db, userId).AnyAsync(ct);
    }

    /// The user's membership in tenantId, or their oldest one when tenantId is
    /// null. Null = not a member (or no household at all).
    public static Task<Membership?> PickAsync(StreamIqDbContext db, Guid userId, Guid? tenantId, CancellationToken ct)
    {
        var q = Of(db, userId);
        return (tenantId is { } t ? q.Where(m => m.TenantId == t) : q).FirstOrDefaultAsync(ct);
    }
}
