using Microsoft.AspNetCore.Hosting;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests;

// Boots through the shared IntegrationFixture: Program's startup now hard-requires
// Firebase init + a DB migrate (Task 3), so the app can only boot against the
// configured factory (emulator host + Testcontainers Postgres). /healthz is
// anonymous, so it still returns 200 through that fully-wired host.
[Collection("integration")]
public class HealthzTests(IntegrationFixture fx)
{
    [Fact]
    public async Task Healthz_returns_success()
    {
        using var client = fx.Factory.CreateClient();

        var response = await client.GetAsync("/healthz");

        response.EnsureSuccessStatusCode();
    }

    [Theory]
    [InlineData("/healthz")]
    [InlineData("/api/me")]        // 401
    [InlineData("/some/client/route")]
    public async Task Every_response_carries_the_security_headers(string path)
    {
        using var client = fx.Factory.CreateClient();

        var response = await client.GetAsync(path);

        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("frame-ancestors 'none'", response.Headers.GetValues("Content-Security-Policy").Single());
        Assert.Equal("no-referrer", response.Headers.GetValues("Referrer-Policy").Single());
    }

    [Fact]
    public void Production_refuses_to_start_against_the_auth_emulator()
    {
        using var factory = fx.Factory.WithWebHostBuilder(b => b.UseEnvironment("Production"));

        var ex = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
        Assert.Contains("FIREBASE_AUTH_EMULATOR_HOST", ex.ToString());
    }
}
