using System.Reflection;
using System.Threading.RateLimiting;
using FirebaseAdmin;
using Google.Apis.Auth.OAuth2;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;
using StreamIq.Api.Features.Gateways;
using StreamIq.Api.Features.Household;
using StreamIq.Api.Features.Invites;
using StreamIq.Api.Features.Members;
using StreamIq.Api.Features.Onboarding;
using StreamIq.Api.Features.Tunnels;

// Wiring only: its branches are config switches, not decisions to test.
[assembly: System.Diagnostics.CodeAnalysis.SuppressMessage("Maintainability", "CA1502",
    Scope = "member", Target = "~M:Program.<Main>$(System.String[])", Justification = "wiring")]

var builder = WebApplication.CreateBuilder(args);

// Only the SPA needs listing: the gateway isn't a browser, and WebSockets ignore CORS
// (/api/broker/ws authenticates in-band).
var corsOrigins = (builder.Configuration["CORS_ORIGINS"] ?? "http://localhost:5173")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(corsOrigins).WithHeaders("Authorization", "Content-Type", Households.Header)
        .WithExposedHeaders(Households.NotMemberHeader).AllowAnyMethod()));

// User-secrets (Development only) load before env vars, so ConnectionStrings__Default
// in the environment wins. Railway's DATABASE_URL is URL form: Normalize converts it.
var rawConn = builder.Configuration.GetConnectionString("Default")
    ?? builder.Configuration["DATABASE_URL"]
    ?? "Host=localhost;Port=5432;Database=streamiq;Username=streamiq;Password=dev";
var connString = StreamIq.Api.ConnectionString.Normalize(rawConn);
builder.Services.AddDbContext<StreamIqDbContext>(o => o.UseNpgsql(connString));

// With FIREBASE_AUTH_EMULATOR_HOST set, VerifyIdTokenAsync skips the signature: same
// call as prod. No default project ID: a wrong one rejects every real login.
// demo-* projects only exist in the emulator (Firebase convention).
var firebaseProjectId = builder.Configuration["FIREBASE_PROJECT_ID"];
var usingEmulator = !string.IsNullOrEmpty(builder.Configuration["FIREBASE_AUTH_EMULATOR_HOST"]);
if (usingEmulator && builder.Environment.IsProduction())
{
    // The emulator accepts unsigned tokens: never in production.
    throw new InvalidOperationException("FIREBASE_AUTH_EMULATOR_HOST is set in Production.");
}
if (FirebaseApp.DefaultInstance is null)
{
    if (string.IsNullOrWhiteSpace(firebaseProjectId))
    {
        throw new InvalidOperationException("FIREBASE_PROJECT_ID is not set.");
    }
    if (!usingEmulator && firebaseProjectId.StartsWith("demo-", StringComparison.Ordinal))
    {
        throw new InvalidOperationException(
            $"FIREBASE_PROJECT_ID is '{firebaseProjectId}', a demo project, but no emulator host is set. " +
            "Set it to the real Firebase project ID.");
    }
    // Railway has no ambient ADC. The env var first: it is the source of truth for a
    // container-injected multi-line JSON secret.
    var serviceAccountJson = (Environment.GetEnvironmentVariable("FIREBASE_SERVICE_ACCOUNT_JSON")
        ?? builder.Configuration["FIREBASE_SERVICE_ACCOUNT_JSON"])?.Trim();
    if (!usingEmulator && string.IsNullOrEmpty(serviceAccountJson))
    {
        throw new InvalidOperationException(
            "FIREBASE_SERVICE_ACCOUNT_JSON is empty at runtime (and no emulator host set). " +
            "The process cannot see the env var — check it's set on the running service, not just build.");
    }
    // Typed parse rejects non-service-account JSON (why GoogleCredential.FromJson was deprecated).
    FirebaseApp.Create(new AppOptions
    {
        ProjectId = firebaseProjectId,
        Credential = usingEmulator
            ? GoogleCredential.FromAccessToken("owner")     // dummy; emulator ignores it
            : CredentialFactory.FromJson<ServiceAccountCredential>(serviceAccountJson).ToGoogleCredential(),
    });
}

builder.Services.AddScoped<UserProvisioner>();
builder.Services.AddAuthentication("Firebase")
    .AddScheme<AuthenticationSchemeOptions, FirebaseAuthHandler>("Firebase", _ => { });
builder.Services.AddAuthorization();

// Enrollments, enrollment tokens, invites and new households per client IP per minute
// (the Go API limits the broker sockets with the same settings). Prod sets
// STREAMIQ_CLIENT_IP_HEADER to Railway's X-Real-IP (Dockerfile). Never the raw
// X-Forwarded-For header: the client writes its left entries; RemoteIpAddress is
// its rightmost one, which Railway's proxy appends (ASPNETCORE_FORWARDEDHEADERS_ENABLED).
// A flood shield, loose on purpose: users behind one carrier NAT share this budget.
// ponytail: in-memory per instance, no per-user limit; key one on the verified user
// if a single account ever abuses it.
var clientIpHeader = builder.Configuration["STREAMIQ_CLIENT_IP_HEADER"];
var signalingPerMinute = builder.Configuration.GetValue("STREAMIQ_SIGNALING_PER_MINUTE", 120);
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy("signaling", ctx => RateLimitPartition.GetFixedWindowLimiter(
        (clientIpHeader is { Length: > 0 } ? ctx.Request.Headers[clientIpHeader].ToString() : null) is { Length: > 0 } ip
            ? ip : ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = signalingPerMinute, Window = TimeSpan.FromMinutes(1) }));
});

// Container hosts inject $PORT; locally launchSettings sets the URL.
if (Environment.GetEnvironmentVariable("PORT") is { Length: > 0 } port)
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
}

var app = builder.Build();

// ponytail: single-instance MVP — migrate on boot. Move to a deploy/CI step if we
// ever run multiple API instances (concurrent migrate is unsafe).
using (var scope = app.Services.CreateScope())
{
    await scope.ServiceProvider.GetRequiredService<StreamIqDbContext>().Database.MigrateAsync();
}

// On every response, the SPA's files included. ponytail: no script/connect CSP yet
// (Firebase sign-in, hls.js workers and blob URLs need a tested allowlist).
app.Use((ctx, next) =>
{
    ctx.Response.Headers.XContentTypeOptions = "nosniff";
    ctx.Response.Headers.ContentSecurityPolicy = "frame-ancestors 'none'";
    // Origin only, never the path. Not no-referrer: the Firebase web API key is
    // restricted by HTTP referrer, and sign-in fails without one.
    ctx.Response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    return next(ctx);
});

// The prod image copies the Vite build into wwwroot; in dev, vite serves it.
app.UseDefaultFiles();
app.UseStaticFiles();

app.UseCors(); // before auth, so preflights are answered without hitting it
app.UseAuthentication();
// Same 404 as for a household that doesn't exist, so membership doesn't leak.
app.Use((ctx, next) =>
{
    if (ctx.Items.ContainsKey(Households.Denied))
    {
        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        ctx.Response.Headers[Households.NotMemberHeader] = "1";
        return Task.CompletedTask;
    }
    return next(ctx);
});
app.UseAuthorization();
app.UseRateLimiter();

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

// Everything but /healthz sits under /api, so SPA client routes own the rest of the path space.
var api = app.MapGroup("/api");
ListGateways.Map(api);
GetGatewayHealth.Map(api);
CreateEnrollmentToken.Map(api);
Enroll.Map(api);
EndTunnel.Map(api);
ListTunnels.Map(api);
TunnelSummary.Map(api);
CreateInvite.Map(api);
ListInvites.Map(api);
RevokeInvite.Map(api);
AcceptInvite.Map(api);
ListMembers.Map(api);
RemoveMember.Map(api);
SetMemberRole.Map(api);
RenameHousehold.Map(api);
CreateHousehold.Map(api);

// Unknown /api/* paths are a 404, never the SPA; any other path without a file
// extension is a client route and gets index.html (404 if no SPA is built, e.g. dev).
api.MapFallback(() => Results.NotFound());
app.MapFallbackToFile("index.html");

app.Run();

// ponytail: marker so integration tests can use WebApplicationFactory<Program>
public partial class Program;
