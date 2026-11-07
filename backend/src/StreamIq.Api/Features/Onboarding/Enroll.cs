using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Onboarding;

/// Gateway spends its enrollment token: creates the gateway row (tenant from the
/// token, pinned DTLS fingerprint) and receives its long-lived credential once.
/// Unauthenticated — the one-time token IS the auth.
public static partial class Enroll
{
    public record Request(string? Token, string? Fingerprint, string? Name);

    // `sha-256 AA:BB:…` (32 upper-case hex pairs) — the contract form in docs/protocol.md.
    [GeneratedRegex("^sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$")]
    private static partial Regex FingerprintRe();

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost("/gateways/enroll", async (Request req, StreamIqDbContext db, CancellationToken ct) =>
        {
            if (req.Token is not { Length: > 0 } || req.Fingerprint is null || !FingerprintRe().IsMatch(req.Fingerprint))
            {
                return Results.BadRequest();
            }

            var hash = Secrets.Hash(req.Token);
            var now = DateTimeOffset.UtcNow;
            await using var tx = await db.Database.BeginTransactionAsync(ct);

            // Tenant-filter exception 1 of 2: the token establishes the tenant, so the
            // lookup can't be tenant-scoped. Conditional UPDATE = single-use under races.
            var tokens = db.EnrollmentTokens.IgnoreQueryFilters().Where(t => t.TokenHash == hash);
            var claimed = await tokens.Where(t => t.UsedAt == null && t.ExpiresAt > now)
                .ExecuteUpdateAsync(s => s.SetProperty(t => t.UsedAt, now), ct);
            if (claimed != 1)
            {
                return Results.Unauthorized();
            }

            var tenantId = await tokens.Select(t => t.TenantId).SingleAsync(ct);

            var credential = Secrets.New(32);   // 256 bit
            var gateway = new Gateway
            {
                TenantId = tenantId,
                Name = req.Name is { Length: > 0 } n ? n[..Math.Min(n.Length, 100)] : "gateway",
                DtlsFingerprint = req.Fingerprint,
                CredentialHash = Secrets.Hash(credential),
            };
            db.Gateways.Add(gateway);
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return Results.Ok(new { gatewayId = gateway.Id, credential });
        }).RequireRateLimiting("signaling");
    }
}
