using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Reqnroll;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Features.Auth;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Gateways;

[Binding]
public class GatewayHealthSteps(IntegrationFixture fx, HouseholdsSteps households)
{
    private HttpResponseMessage _read = new();

    // Each row's Jellyfin version names its age ("d8"), so the read shows which rows came back.
    [Given("gateway \"([^\"]*)\" has health rows ([0-9]+), ([0-9]+), ([0-9]+) and ([0-9]+) days old")]
    public async Task GivenAged(string name, int a, int b, int c, int d)
    {
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        var id = households.GatewayId(name);
        var tenant = await db.Gateways.IgnoreQueryFilters().Where(g => g.Id == id).Select(g => g.TenantId).SingleAsync();
        foreach (var days in new[] { a, b, c, d })
        {
            db.GatewayHealth.Add(new GatewayHealth
            {
                TenantId = tenant,
                GatewayId = id,
                At = DateTimeOffset.UtcNow.AddDays(-days),
                Level = "full",
                JellyfinVersion = $"d{days}",
            });
        }
        await db.SaveChangesAsync();
    }

    [When("\"([^\"]*)\" reads the health of gateway \"([^\"]*)\" in the household of \"([^\"]*)\"")]
    public async Task WhenRead(string email, string name, string owner)
    {
        using var client = await households.SignedIn(email);
        client.DefaultRequestHeaders.Add(StreamIq.Api.Auth.Households.Header, (await households.HouseholdOf(owner)).ToString());
        _read = await client.GetAsync($"/api/gateways/{households.GatewayId(name)}/health");
    }

    [When("\"([^\"]*)\" reads the health of an unknown gateway")]
    public async Task WhenReadUnknown(string email)
    {
        using var client = await households.SignedIn(email);
        _read = await client.GetAsync($"/api/gateways/{Guid.NewGuid()}/health");
    }

    [Then("the health read lists the rows ([0-9]+), ([0-9]+) and ([0-9]+) days old, in that order")]
    public async Task ThenReadRows(int a, int b, int c)
    {
        Assert.Equal(HttpStatusCode.OK, _read.StatusCode);
        var rows = await _read.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal([$"d{a}", $"d{b}", $"d{c}"], rows.EnumerateArray().Select(r => r.GetProperty("jellyfinVersion").GetString()));
    }

    [Then("the health read is not found")]
    public void ThenReadNotFound()
    {
        Assert.Equal(HttpStatusCode.NotFound, _read.StatusCode);
    }
}
