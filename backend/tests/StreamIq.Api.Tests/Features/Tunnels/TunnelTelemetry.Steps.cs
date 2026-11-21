using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Reqnroll;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Features.Auth;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Tunnels;

[Binding]
public class TunnelTelemetrySteps(IntegrationFixture fx, HouseholdsSteps households)
{
    private HttpResponseMessage? _last;
    private Guid _tunnel;

    private async Task<Tunnel> Row()
    {
        using var scope = fx.Factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<StreamIqDbContext>().Tunnels.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(t => t.Id == _tunnel);
    }

    private async Task<JsonElement> Me(string email)
    {
        using var client = await households.SignedIn(email);
        return await OwnHousehold.MeAsync(fx, client);
    }

    // The row as the broker writes it for a routed offer.
    [Given("\"([^\"]*)\" has a tunnel to gateway \"([^\"]*)\"")]
    public async Task GivenTunnel(string email, string name)
    {
        var me = await Me(email);
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        _tunnel = Guid.NewGuid();
        db.Tunnels.Add(new Tunnel
        {
            Id = _tunnel,
            TenantId = me.GetProperty("tenantId").GetGuid(),
            GatewayId = households.GatewayId(name),
            UserId = me.GetProperty("userId").GetGuid(),
        });
        await db.SaveChangesAsync();
    }

    [When("\"([^\"]*)\" reports ([0-9]+) kbps for that tunnel")]
    public async Task WhenThroughput(string email, int kbps)
    {
        await Me(email);
        using var client = await households.SignedIn(email);
        _last = await client.PatchAsJsonAsync($"/api/tunnels/{_tunnel}", new { throughputKbps = kbps });
    }

    // A member of the tunnel's household still can't touch another user's tunnel.
    [When("\"([^\"]*)\" reports ([0-9]+) kbps for that tunnel naming the household of \"([^\"]*)\"")]
    public async Task WhenThroughputNaming(string email, int kbps, string owner)
    {
        var household = (await Me(owner)).GetProperty("tenantId").GetString();
        using var client = await households.SignedIn(email);
        client.DefaultRequestHeaders.Add(StreamIq.Api.Auth.Households.Header, household);
        _last = await client.PatchAsJsonAsync($"/api/tunnels/{_tunnel}", new { throughputKbps = kbps });
    }

    [Then("the throughput is accepted")]
    public void ThenAccepted()
    {
        Assert.Equal(HttpStatusCode.NoContent, _last?.StatusCode);
    }

    [Then("the request is refused with 404")]
    public void ThenNotFound()
    {
        Assert.Equal(HttpStatusCode.NotFound, _last?.StatusCode);
    }

    [Then("the tunnel has ([0-9]+) kbps")]
    public async Task ThenKbps(int kbps)
    {
        Assert.Equal(kbps, (await Row()).ThroughputKbps);
    }

    [Then("the tunnel has no throughput")]
    public async Task ThenNoKbps()
    {
        Assert.Null((await Row()).ThroughputKbps);
    }
}
