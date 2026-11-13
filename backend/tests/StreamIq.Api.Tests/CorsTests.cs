using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests;

// The CORS allowlist (CORS_ORIGINS, default = vite dev origin): a listed origin gets
// its preflight approved, anyone else gets no Access-Control-Allow-Origin header.
[Collection("integration")]
public class CorsTests(IntegrationFixture fx)
{
    [Theory]
    [InlineData("http://localhost:5173", true)]
    [InlineData("https://evil.example", false)]
    public async Task Preflight_allows_only_listed_origins(string origin, bool allowed)
    {
        using var client = fx.Factory.CreateClient();
        using var preflight = new HttpRequestMessage(HttpMethod.Options, "/api/me");
        preflight.Headers.Add("Origin", origin);
        preflight.Headers.Add("Access-Control-Request-Method", "GET");
        preflight.Headers.Add("Access-Control-Request-Headers", "authorization");

        using var response = await client.SendAsync(preflight);

        response.Headers.TryGetValues("Access-Control-Allow-Origin", out var values);
        Assert.Equal(allowed ? [origin] : null, values?.ToArray());
    }

    // The web app reads the not-a-member marker (#210); cross-origin (vite dev) only if exposed.
    [Fact]
    public async Task Not_member_header_is_exposed()
    {
        using var client = fx.Factory.CreateClient();
        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/me");
        req.Headers.Add("Origin", "http://localhost:5173");

        using var response = await client.SendAsync(req);

        Assert.True(response.Headers.TryGetValues("Access-Control-Expose-Headers", out var values));
        Assert.Contains(StreamIq.Api.Auth.Households.NotMemberHeader, values);
    }
}
