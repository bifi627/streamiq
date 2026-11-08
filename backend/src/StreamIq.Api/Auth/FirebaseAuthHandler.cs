using System.Security.Claims;
using System.Text.Encodings.Web;
using FirebaseAdmin.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using StreamIq.Api.Data;

namespace StreamIq.Api.Auth;

/// Scheme "Firebase": verify the Bearer ID token (same VerifyIdTokenAsync call in
/// dev and prod — emulator vs real issuer is env-only, no bypass), resolve-or-
/// provision the user, and set CurrentTenantId so the global filter is live.
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

        db.CurrentTenantId = user.TenantId;

        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new Claim("tenant_id", user.TenantId.ToString()),
            new Claim("firebase_uid", user.FirebaseUid),
        };
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name));
        return AuthenticateResult.Success(new AuthenticationTicket(principal, Scheme.Name));
    }
}
