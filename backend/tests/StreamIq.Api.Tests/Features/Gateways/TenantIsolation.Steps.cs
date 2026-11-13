using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Reqnroll;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Gateways;

[Binding]
public class TenantIsolationSteps(IntegrationFixture fx)
{
    private JsonElement _lastList;

    private async Task<HttpClient> SignIn(string email)
    {
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123");
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        await client.GetAsync("/api/me");     // ensure provisioned
        return client;
    }

    [Given("a signed-in user \"(.*)\"")]
    public async Task GivenSignedIn(string email)
    {
        (await SignIn(email)).Dispose();
    }

    [Given("that user's tenant owns a gateway named \"(.*)\"")]
    public async Task GivenOwnsGateway(string name)
    {
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        var tenantId = db.Memberships.IgnoreQueryFilters().OrderBy(m => m.CreatedAt).Last().TenantId;
        db.Gateways.Add(new Gateway { TenantId = tenantId, Name = name, CredentialHash = "seeded" });
        await db.SaveChangesAsync();
    }

    [When("\"(.*)\" signs in and lists gateways")]
    [When("\"(.*)\" lists gateways")]
    public async Task WhenLists(string email)
    {
        using var client = await SignIn(email);
        _lastList = await client.GetFromJsonAsync<JsonElement>("/api/gateways");
    }

    [Then("the gateway list is empty")]
    public void ThenEmpty()
    {
        Assert.Equal(0, _lastList.GetArrayLength());
    }

    [Then("the gateway list contains \"(.*)\"")]
    public void ThenContains(string name)
    {
        var names = _lastList.EnumerateArray().Select(d => d.GetProperty("name").GetString());
        Assert.Contains(name, names);
    }
}
