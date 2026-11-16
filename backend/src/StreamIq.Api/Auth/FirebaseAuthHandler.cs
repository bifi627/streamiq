using System.Security.Claims;
using System.Text.Encodings.Web;
using FirebaseAdmin.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using StreamIq.Api.Data;

namespace StreamIq.Api.Auth;

/// Scheme "Firebase": verify the Bearer ID token (same VerifyIdTokenAsync call in
/// dev and prod — emulator vs real issuer is env-only, no bypass), resolve-or-
/// provision the user, pick the request's household from the user's memberships
/// (Households) and set CurrentTenantId so the global filter is live. The membership's
/// role is the Role claim: admin-only endpoints RequireRole it, so a member gets 403. A household
/// the user can't use flags the request for a 404 (Program.cs), same as one that
/// doesn't exist; so does having no household, except on Households.Optional endpoints.
public class FirebaseAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    UserProvisioner provisioner,
    StreamIqDbContext db)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            return AuthenticateResult.NoResult();   // no creds → [Authorize] returns 401
        }

        var idToken = header["Bearer ".Length..].Trim();

        FirebaseToken decoded;
        try
        {
            decoded = await FirebaseAuth.DefaultInstance.VerifyIdTokenAsync(idToken, Context.RequestAborted);
        }
        catch (Exception ex)
        {
            return AuthenticateResult.Fail(ex.Message);
        }

        var user = await provisioner.ResolveOrProvisionAsync(decoded.Uid, Context.RequestAborted);

        // A malformed id is Guid.Empty: no tenant has it, so it's a non-member 404 too.
        Guid? wanted = Request.Headers[Households.Header] is { Count: > 0 } h
            ? Guid.TryParse(h.ToString(), out var id) ? id : Guid.Empty
            : null;
        var membership = await Households.PickAsync(db, user.Id, wanted, Context.RequestAborted);
        // No household at all (#387): only the endpoints marked Households.Optional,
        // with no tenant claims and CurrentTenantId left null (the filter shows nothing).
        var optional = wanted is null && Context.GetEndpoint()?.Metadata.Contains(Households.Optional) == true;
        if (membership is null && !optional)
        {
            Context.Items[Households.Denied] = true;
            return AuthenticateResult.Fail("not a member of that household");
        }

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new("firebase_uid", user.FirebaseUid),
        };
        if (membership is not null)
        {
            db.CurrentTenantId = membership.TenantId;
            claims.Add(new Claim("tenant_id", membership.TenantId.ToString()));
            claims.Add(new Claim(ClaimTypes.Role, membership.Role));   // admin-only endpoints: RequireRole(Membership.Admin)
        }
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name));
        return AuthenticateResult.Success(new AuthenticationTicket(principal, Scheme.Name));
    }
}
