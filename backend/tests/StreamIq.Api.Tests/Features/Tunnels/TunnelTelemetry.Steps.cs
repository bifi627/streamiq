using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Reqnroll;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Tunnels;

[Binding]
public class TunnelTelemetrySteps(IntegrationFixture fx)
{
    private readonly Dictionary<string, Guid> _gateways = [];
    private Guid _tunnel;
    private HttpResponseMessage? _last;

    private async Task<HttpClient> SignIn(string email)
    {
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123");
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        await client.GetAsync("/api/me");     // ensure provisioned
        return client;
    }

    // Raw rows: the test reads across tenants on purpose (no CurrentTenantId ⇒
    // the filter would hide everything).
    private static IQueryable<Tunnel> AllTunnels(StreamIqDbContext db)
    {
        return db.Tunnels.IgnoreQueryFilters();
    }

    [Given("\"(.*)\" owns a gateway named \"(.*)\"")]
    public async Task GivenOwnsGateway(string email, string name)
    {
        Guid tenantId;
        using (var client = await SignIn(email))
        {
            tenantId = (await client.GetFromJsonAsync<JsonElement>("/api/me")).GetProperty("tenantId").GetGuid();
        }
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        var gw = new Gateway { TenantId = tenantId, Name = name };
        db.Gateways.Add(gw);
        await db.SaveChangesAsync();
        _gateways[name] = gw.Id;
    }

    [When("\"(.*)\" opens a relayed tunnel on \"(.*)\"")]
    public async Task WhenStarts(string email, string gateway)
    {
        using var client = await SignIn(email);
        _last = await client.PostAsJsonAsync("/api/tunnels", new
        {
            gatewayId = _gateways[gateway],
            relay = true,
            ipv6 = false,
            localCandidateType = "relay",
            remoteCandidateType = "host",
            protocol = "udp",
        });
        if (_last.IsSuccessStatusCode)
        {
            _tunnel = (await _last.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        }
    }

    [When("\"(.*)\" logs a failed tunnel on \"(.*)\" because \"(.*)\"")]
    public async Task WhenFails(string email, string gateway, string reason)
    {
        using var client = await SignIn(email);
        _last = await client.PostAsJsonAsync("/api/tunnels", new { gatewayId = _gateways[gateway], failure = reason });
    }

    [Then("the tunnel is stored as failed because \"(.*)\"")]
    public async Task ThenFailed(string reason)
    {
        Assert.Equal(HttpStatusCode.OK, _last?.StatusCode);
        using var scope = fx.Factory.Services.CreateScope();
        var row = await AllTunnels(scope.ServiceProvider.GetRequiredService<StreamIqDbContext>()).SingleAsync();
        Assert.Equal(reason, row.Failure);
        Assert.Null(row.LocalCandidateType);
    }

    [When("\"(.*)\" ends that tunnel with ([0-9]+) bytes received")]
    public async Task WhenEnds(string email, long bytes)
    {
        using var client = await SignIn(email);
        _last = await client.PatchAsJsonAsync($"/api/tunnels/{_tunnel}", new { bytesReceived = bytes, bytesSent = 10 });
    }

    [When("\"(.*)\" ends that tunnel with ([0-9]+) bytes received and ([0-9]+) kbps measured")]
    public async Task WhenEndsMeasured(string email, long bytes, int kbps)
    {
        using var client = await SignIn(email);
        _last = await client.PatchAsJsonAsync($"/api/tunnels/{_tunnel}", new { bytesReceived = bytes, bytesSent = 10, throughputKbps = kbps });
    }

    [Then("the request is refused with 404")]
    public void ThenNotFound()
    {
        Assert.Equal(HttpStatusCode.NotFound, _last?.StatusCode);
    }

    [Then("no tunnel is stored")]
    public async Task ThenNone()
    {
        using var scope = fx.Factory.Services.CreateScope();
        Assert.Equal(0, await AllTunnels(scope.ServiceProvider.GetRequiredService<StreamIqDbContext>()).CountAsync());
    }

    [Then("the tunnel has no end time")]
    public async Task ThenNotEnded()
    {
        using var scope = fx.Factory.Services.CreateScope();
        var row = await AllTunnels(scope.ServiceProvider.GetRequiredService<StreamIqDbContext>()).SingleAsync();
        Assert.Null(row.EndedAt);
        Assert.Null(row.BytesReceived);
    }

    [Then("the tunnel is stored as relayed with ([0-9]+) bytes received, ([0-9]+) kbps and an end time")]
    public async Task ThenStoredMeasured(long bytes, int kbps)
    {
        Assert.Equal(kbps, (await ThenStored(bytes)).ThroughputKbps);
    }

    [Then("the tunnel is stored as relayed with ([0-9]+) bytes received, no throughput and an end time")]
    public async Task ThenStoredUnmeasured(long bytes)
    {
        Assert.Null((await ThenStored(bytes)).ThroughputKbps);
    }

    private async Task<Tunnel> ThenStored(long bytes)
    {
        Assert.Equal(HttpStatusCode.NoContent, _last?.StatusCode);
        using var scope = fx.Factory.Services.CreateScope();
        var row = await AllTunnels(scope.ServiceProvider.GetRequiredService<StreamIqDbContext>()).SingleAsync();
        Assert.True(row.Relay);
        Assert.Equal(bytes, row.BytesReceived);
        Assert.NotNull(row.EndedAt);
        Assert.Equal(_gateways["alice-nas"], row.GatewayId);
        return row;
    }
}
