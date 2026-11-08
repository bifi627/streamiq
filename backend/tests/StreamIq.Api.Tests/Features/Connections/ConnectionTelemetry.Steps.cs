using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Reqnroll;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Connections;

[Binding]
public class ConnectionTelemetrySteps(IntegrationFixture fx)
{
    private readonly Dictionary<string, Guid> _gateways = [];
    private Guid _session;
    private HttpResponseMessage? _last;

    private async Task<HttpClient> SignIn(string email)
    {
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123");
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        await client.GetAsync("/me");     // ensure provisioned
        return client;
    }

    // Raw rows: the test reads across tenants on purpose (no CurrentTenantId ⇒
    // the filter would hide everything).
    private static IQueryable<ConnectionSession> AllSessions(StreamIqDbContext db)
    {
        return db.ConnectionSessions.IgnoreQueryFilters();
    }

    [Given("\"(.*)\" owns a gateway named \"(.*)\"")]
    public async Task GivenOwnsGateway(string email, string name)
    {
        Guid tenantId;
        using (var client = await SignIn(email))
        {
            tenantId = (await client.GetFromJsonAsync<JsonElement>("/me")).GetProperty("tenantId").GetGuid();
        }
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        var gw = new Gateway { TenantId = tenantId, Name = name };
        db.Gateways.Add(gw);
        await db.SaveChangesAsync();
        _gateways[name] = gw.Id;
    }

    [When("\"(.*)\" starts a relayed session on \"(.*)\"")]
    public async Task WhenStarts(string email, string gateway)
    {
        using var client = await SignIn(email);
        _last = await client.PostAsJsonAsync("/connections", new
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
            _session = (await _last.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        }
    }

    [When("\"(.*)\" logs a failed attempt on \"(.*)\" because \"(.*)\"")]
    public async Task WhenFails(string email, string gateway, string reason)
    {
        using var client = await SignIn(email);
        _last = await client.PostAsJsonAsync("/connections", new { gatewayId = _gateways[gateway], failure = reason });
    }

    [Then("the session is stored as failed because \"(.*)\"")]
    public async Task ThenFailed(string reason)
    {
        Assert.Equal(HttpStatusCode.OK, _last?.StatusCode);
        using var scope = fx.Factory.Services.CreateScope();
        var row = await AllSessions(scope.ServiceProvider.GetRequiredService<StreamIqDbContext>()).SingleAsync();
        Assert.Equal(reason, row.Failure);
        Assert.Null(row.LocalCandidateType);
    }

    [When("\"(.*)\" ends that session with ([0-9]+) bytes received")]
    public async Task WhenEnds(string email, long bytes)
    {
        using var client = await SignIn(email);
        _last = await client.PatchAsJsonAsync($"/connections/{_session}", new { bytesReceived = bytes, bytesSent = 10 });
    }

    [Then("the request is refused with 404")]
    public void ThenNotFound()
    {
        Assert.Equal(HttpStatusCode.NotFound, _last?.StatusCode);
    }

    [Then("no session is stored")]
    public async Task ThenNone()
    {
        using var scope = fx.Factory.Services.CreateScope();
        Assert.Equal(0, await AllSessions(scope.ServiceProvider.GetRequiredService<StreamIqDbContext>()).CountAsync());
    }

    [Then("the session has no end time")]
    public async Task ThenNotEnded()
    {
        using var scope = fx.Factory.Services.CreateScope();
        var row = await AllSessions(scope.ServiceProvider.GetRequiredService<StreamIqDbContext>()).SingleAsync();
        Assert.Null(row.EndedAt);
        Assert.Null(row.BytesReceived);
    }

    [Then("the session is stored as relayed with ([0-9]+) bytes received and an end time")]
    public async Task ThenStored(long bytes)
    {
        Assert.Equal(HttpStatusCode.NoContent, _last?.StatusCode);
        using var scope = fx.Factory.Services.CreateScope();
        var row = await AllSessions(scope.ServiceProvider.GetRequiredService<StreamIqDbContext>()).SingleAsync();
        Assert.True(row.Relay);
        Assert.Equal(bytes, row.BytesReceived);
        Assert.NotNull(row.EndedAt);
        Assert.Equal(_gateways["alice-nas"], row.GatewayId);
    }
}
