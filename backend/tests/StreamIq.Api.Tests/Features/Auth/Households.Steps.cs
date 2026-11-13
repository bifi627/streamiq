using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Reqnroll;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Auth;

/// Household steps; the membership ones are shared with Broker.feature.
/// "The household of X" = X's own household (made by their first sign-in, their oldest).
[Binding]
public class HouseholdsSteps(IntegrationFixture fx)
{
    private readonly Dictionary<string, Guid> _gateways = new();
    private HttpResponseMessage? _last;

    [AfterScenario]
    public void Dispose()
    {
        _last?.Dispose();
    }

    [Given("\"(.*)\" has a gateway named \"(.*)\"")]
    public async Task GivenGateway(string email, string name)
    {
        var tenant = await HouseholdOf(email);
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        var gw = new Gateway { TenantId = tenant, Name = name, CredentialHash = Guid.NewGuid().ToString() };
        db.Gateways.Add(gw);
        await db.SaveChangesAsync();
        _gateways[name] = gw.Id;
    }

    [Given("\"(.*)\" is a member of the household of \"(.*)\"")]
    public async Task GivenMember(string email, string owner)
    {
        var (user, tenant) = (await UserIdOf(email), await HouseholdOf(owner));
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        db.Memberships.Add(new Membership { TenantId = tenant, UserId = user, Role = Membership.Member });
        await db.SaveChangesAsync();
    }

    [When("the membership of \"(.*)\" in the household of \"(.*)\" is removed")]
    public async Task WhenRemoved(string email, string owner)
    {
        var (user, tenant) = (await UserIdOf(email), await HouseholdOf(owner));
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        db.CurrentTenantId = tenant;   // through the tenant filter, as a members page would
        Assert.Equal(1, await db.Memberships.Where(m => m.UserId == user).ExecuteDeleteAsync());
    }

    [When("\"(.*)\" lists gateways in the household of \"(.*)\"")]
    public async Task WhenListsIn(string email, string owner)
    {
        await Send(email, HttpMethod.Get, "/api/gateways", (await HouseholdOf(owner)).ToString());
    }

    [When("\"(.*)\" lists gateways in household \"(.*)\"")]
    public Task WhenListsInRaw(string email, string household)
    {
        return Send(email, HttpMethod.Get, "/api/gateways", household);
    }

    [When("\"(.*)\" lists gateways without naming a household")]
    public Task WhenLists(string email)
    {
        return Send(email, HttpMethod.Get, "/api/gateways", null);
    }

    [When("\"(.*)\" creates an enrollment token in the household of \"(.*)\"")]
    public async Task WhenEnrollmentToken(string email, string owner)
    {
        await Send(email, HttpMethod.Post, "/api/gateways/enrollment-tokens", (await HouseholdOf(owner)).ToString());
    }

    [When("\"(.*)\" removes gateway \"(.*)\" in the household of \"(.*)\"")]
    public async Task WhenRemovesIn(string email, string name, string owner)
    {
        await Send(email, HttpMethod.Delete, $"/api/gateways/{_gateways[name]}", (await HouseholdOf(owner)).ToString());
    }

    [Then("the request is refused as not found")]
    public void ThenNotFound()
    {
        Assert.NotNull(_last);
        Assert.Equal(HttpStatusCode.NotFound, _last.StatusCode);
    }

    [Then("the list holds exactly \"(.*)\"")]
    public async Task ThenExactly(string name)
    {
        Assert.NotNull(_last);
        Assert.Equal(HttpStatusCode.OK, _last.StatusCode);
        var list = await _last.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal([name], list.EnumerateArray().Select(g => g.GetProperty("name").GetString()));
    }

    [Then("\"(.*)\" still lists only gateway \"(.*)\"")]
    public async Task ThenStillListed(string email, string name)
    {
        await Send(email, HttpMethod.Get, "/api/gateways", null);
        await ThenExactly(name);
    }

    [Then("\"(.*)\" is \"(.*)\" of the household of \"(.*)\" and \"(.*)\" of the household of \"(.*)\"")]
    public async Task ThenRoles(string email, string role1, string owner1, string role2, string owner2)
    {
        var got = (await Me(email)).GetProperty("memberships").EnumerateArray()
            .Select(m => (m.GetProperty("id").GetGuid(), m.GetProperty("role").GetString()));
        Assert.Equal([(await HouseholdOf(owner1), role1), (await HouseholdOf(owner2), role2)], got);   // oldest first
    }

    private async Task Send(string email, HttpMethod method, string path, string? household)
    {
        using var client = await SignedIn(email);
        using var req = new HttpRequestMessage(method, path);
        if (household is not null)
        {
            req.Headers.TryAddWithoutValidation(Households.Header, household);
        }
        _last?.Dispose();
        _last = await client.SendAsync(req);
    }

    private async Task<HttpClient> SignedIn(string email)
    {
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123"));
        return client;
    }

    // X's own household: their oldest membership, which /me without the header acts in.
    private async Task<Guid> HouseholdOf(string email)
    {
        return (await Me(email)).GetProperty("tenantId").GetGuid();
    }

    private async Task<Guid> UserIdOf(string email)
    {
        return (await Me(email)).GetProperty("userId").GetGuid();
    }

    private async Task<JsonElement> Me(string email)
    {
        using var client = await SignedIn(email);
        return await client.GetFromJsonAsync<JsonElement>("/api/me");
    }
}
