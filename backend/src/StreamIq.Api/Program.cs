using System.Reflection;
using System.Threading.RateLimiting;
using FirebaseAdmin;
using Google.Apis.Auth.OAuth2;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;
using StreamIq.Api.Features.Broker;
using StreamIq.Api.Features.Connections;
using StreamIq.Api.Features.Gateways;
using StreamIq.Api.Features.Invites;
using StreamIq.Api.Features.Me;
using StreamIq.Api.Features.Members;
using StreamIq.Api.Features.Onboarding;

var builder = WebApplication.CreateBuilder(args);

// CORS allowlist = the SPA origins (comma-separated CORS_ORIGINS; default = vite dev).
// The gateway isn't a browser, and WebSockets ignore CORS (/api/broker/ws
// authenticates in-band), so only the SPA needs listing.
var corsOrigins = (builder.Configuration["CORS_ORIGINS"] ?? "http://localhost:5173")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(corsOrigins).WithHeaders("Authorization", "Content-Type", Households.Header)
        .WithExposedHeaders(Households.NotMemberHeader).AllowAnyMethod()));

// EF Core control-plane store. Key mirrors .env.example (ConnectionStrings__Default);
// falls back to the local compose Postgres.
// User-secrets load via CreateBuilder in Development only, before env vars — so
// ConnectionStrings__Default in the environment always wins.
// Railway's Postgres hands out DATABASE_URL in URL form (postgres://u:p@host:port/db),
// which Npgsql can't parse. Accept either a native key-value string OR a URL from any
// of the usual keys, converting the URL case. ponytail: covers ConnectionStrings__Default
// and Railway's DATABASE_URL with no hand-assembled connection string to get wrong.
var rawConn = builder.Configuration.GetConnectionString("Default")
    ?? builder.Configuration["DATABASE_URL"]
    ?? "Host=localhost;Port=5432;Database=streamiq;Username=streamiq;Password=dev";
var connString = StreamIq.Api.ConnectionString.Normalize(rawConn);
builder.Services.AddDbContext<StreamIqDbContext>(o => o.UseNpgsql(connString));

// FirebaseAdmin init. Emulator (dev): FIREBASE_AUTH_EMULATOR_HOST is set and
// VerifyIdTokenAsync skips the signature — same call as prod. A dummy credential
// satisfies init in emulator mode. Prod needs a real service account: Railway has
// no ambient ADC, so we read the JSON from FIREBASE_SERVICE_ACCOUNT_JSON and fall
// back to GetApplicationDefault() only for GCP-hosted runs.
// No default: a wrong project ID rejects every real login, so refuse to start instead.
// demo-* projects only exist in the emulator (Firebase convention).
var firebaseProjectId = builder.Configuration["FIREBASE_PROJECT_ID"];
if (FirebaseApp.DefaultInstance is null)
{
    var usingEmulator = !string.IsNullOrEmpty(builder.Configuration["FIREBASE_AUTH_EMULATOR_HOST"]);
    if (usingEmulator && builder.Environment.IsProduction())
    {
        // The emulator accepts unsigned tokens: never in production.
        throw new InvalidOperationException("FIREBASE_AUTH_EMULATOR_HOST is set in Production.");
    }
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
    // ponytail: read the env var directly, not via Configuration — the source of
    // truth for a container-injected multi-line/JSON secret.
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
builder.Services.AddHttpClient(); // broker -> Cloudflare TURN

// Signaling rate limit: new sockets + enrollments per client IP per minute. The
// client IP comes from STREAMIQ_CLIENT_IP_HEADER when set (prod: Railway's
// X-Real-IP, set in the Dockerfile; a Cloudflare proxy would be CF-Connecting-IP),
// else RemoteIpAddress. Never the raw X-Forwarded-For header (the client writes
// its left entries); in the image, RemoteIpAddress is its rightmost entry, which
// Railway's proxy appends (ASPNETCORE_FORWARDEDHEADERS_ENABLED).
// A flood shield, loose on purpose: users behind one shared IP (carrier NAT) share
// this budget. ponytail: no per-user limit; add one keyed on the verified user in
// BrowserSocket if a single account ever abuses it. In-memory per instance, like
// the broker registry (issue #40).
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

// Railway (and any container host) inject the port via $PORT. ponytail:
// one-line bind; no-op locally where launchSettings sets the URL.
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
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
    return next(ctx);
});

// SPA: the prod image copies the Vite build into wwwroot (dev: vite serves it).
// Client routes fall back to index.html (end of file); the API lives under /api.
app.UseDefaultFiles();
app.UseStaticFiles();

app.UseCors(); // before auth, so preflights are answered without hitting it
app.UseAuthentication();
// A household the signed-in user isn't a member of (FirebaseAuthHandler): 404 with
// the not-a-member header, the same answer as for a household that doesn't exist. The
// header tells the app "drop your household choice" apart from an ordinary 404 (#210).
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

app.UseWebSockets();

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

// Vertical slices: one file per use case under Features/<Slice>/, mapped here.
// Every slice sits under /api (its own route, e.g. "/me", is relative to it), so
// client routes own the rest of the path space. /healthz stays at the root.
var api = app.MapGroup("/api");
GetMe.Map(api);
ListGateways.Map(api);
RevokeGateway.Map(api);
CreateEnrollmentToken.Map(api);
Enroll.Map(api);
GatewaySocket.Map(api);
BrowserSocket.Map(api);
StartConnection.Map(api);
EndConnection.Map(api);
CreateInvite.Map(api);
ListInvites.Map(api);
RevokeInvite.Map(api);
AcceptInvite.Map(api);
ListMembers.Map(api);
RemoveMember.Map(api);
SetMemberRole.Map(api);

// Unknown /api/* paths are a 404, never the SPA; any other path without a file
// extension is a client route and gets index.html (404 if no SPA is built, e.g. dev).
api.MapFallback(() => Results.NotFound());
app.MapFallbackToFile("index.html");

app.Run();

// ponytail: marker so integration tests can use WebApplicationFactory<Program>
public partial class Program;
