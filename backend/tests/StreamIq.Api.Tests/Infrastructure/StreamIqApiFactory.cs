using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace StreamIq.Api.Tests.Infrastructure;

/// Boots the real API against the test containers. FIREBASE_AUTH_EMULATOR_HOST is
/// process-global and read by FirebaseAdmin at FirebaseApp.Create — set it before
/// the host builds. Config keys mirror .env.example.
public sealed class StreamIqApiFactory(string connString, string emulatorHost)
    : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        Environment.SetEnvironmentVariable("FIREBASE_AUTH_EMULATOR_HOST", emulatorHost);
        builder.UseSetting("ConnectionStrings:Default", connString);
        builder.UseSetting("FIREBASE_PROJECT_ID", "demo-streamiq");
        // Every test request shares one "client IP" (TestServer has none), so the
        // signaling limit is lifted here; RateLimitTests derives a factory with it back on.
        builder.UseSetting("STREAMIQ_SIGNALING_PER_MINUTE", "100000");
    }
}
