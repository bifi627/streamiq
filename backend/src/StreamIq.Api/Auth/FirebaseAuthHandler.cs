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
/// (Households) and set CurrentTenantId so the global filter is live. A household
/// the user can't use flags the request for a 404 (Program.cs), same as one that
/// doesn't exist.
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
        // ponytail: no household at all (only once leaving exists, #192) is a 404 too.
        if (membership is null)
        {
            Context.Items[Households.Denied] = true;
            return AuthenticateResult.Fail("not a member of that household");
        }
        db.CurrentTenantId = membership.TenantId;

        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new Claim("tenant_id", membership.TenantId.ToString()),
            new Claim("firebase_uid", user.FirebaseUid),
        };
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name));
        return AuthenticateResult.Success(new AuthenticationTicket(principal, Scheme.Name));
    }
}
