using System.Net;
using Microsoft.AspNetCore.Hosting;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests;

// Prod serves the SPA from wwwroot: client routes (any path outside /api without a
// file extension) get index.html, unknown /api/* paths stay a 404, /healthz stays JSON.
[Collection("integration")]
public class SpaFallbackTests(IntegrationFixture fx)
{
    [Fact]
    public async Task Client_routes_get_index_html_but_unknown_api_paths_404()
    {
        var webRoot = Directory.CreateTempSubdirectory().FullName;
        await File.WriteAllTextAsync(Path.Combine(webRoot, "index.html"), "<!doctype html>spa");
        using var factory = fx.Factory.WithWebHostBuilder(b => b.UseSetting(WebHostDefaults.WebRootKey, webRoot));
        using var client = factory.CreateClient();

        foreach (var path in new[] { "/", "/g/some-gateway", "/g/some-gateway/i/item" })
        {
            var res = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Equal("<!doctype html>spa", await res.Content.ReadAsStringAsync());
        }

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/nope")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/gateways/x/y")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/me")).StatusCode);   // real endpoint, not the fallback
        Assert.Contains("ok", await client.GetStringAsync("/healthz"));
    }
}
