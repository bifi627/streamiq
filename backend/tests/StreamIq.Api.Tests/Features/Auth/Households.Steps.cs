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

/// Household steps; the membership ones are shared with other features.
/// "The household of X" = X's own household (OwnHousehold: made on first mention, their oldest).
[Binding]
public class HouseholdsSteps(IntegrationFixture fx)
{
    private readonly Dictionary<string, Guid> _gateways = new();

    public Guid GatewayId(string name)
    {
        return _gateways[name];
    }
    private HttpResponseMessage? _last;
    private string? _prevAnswer;

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

    [Given("\"(.*)\" has a household")]
    public Task GivenHousehold(string email)
    {
        return HouseholdOf(email);
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

    [When("\"(.*)\" lists members in the household of \"(.*)\"")]
    public async Task WhenListsIn(string email, string owner)
    {
        await Send(email, HttpMethod.Get, "/api/members", (await HouseholdOf(owner)).ToString());
    }

    [When("\"(.*)\" lists members in household \"(.*)\"")]
    public Task WhenListsInRaw(string email, string household)
    {
        return Send(email, HttpMethod.Get, "/api/members", household);
    }

    [When("\"(.*)\" lists members without naming a household")]
    public Task WhenLists(string email)
    {
        return Send(email, HttpMethod.Get, "/api/members", null);
    }

    [When("\"(.*)\" creates an invite in the household of \"(.*)\"")]
    public async Task WhenInvite(string email, string owner)
    {
        await Send(email, HttpMethod.Post, "/api/invites", (await HouseholdOf(owner)).ToString());
    }

    [Then("the request is refused as not a member")]
    public void ThenNotMember()
    {
        Assert.NotNull(_last);
        Assert.Equal(HttpStatusCode.NotFound, _last.StatusCode);
        Assert.Equal(["1"], _last.Headers.GetValues(Households.NotMemberHeader));
    }

    // Status, headers (bar Date) and body of the last two answers match exactly.
    [Then("both answers are identical")]
    public async Task ThenIdentical()
    {
        Assert.NotNull(_prevAnswer);
        Assert.NotNull(_last);
        Assert.Equal(_prevAnswer, await Answer(_last));
    }

    private static async Task<string> Answer(HttpResponseMessage r)
    {
        var headers = r.Headers.Concat(r.Content.Headers)
            .Where(h => h.Key != "Date")
            .Select(h => $"{h.Key}: {string.Join(",", h.Value)}")
            .Order();
        return $"{(int)r.StatusCode}\n{string.Join("\n", headers)}\n{await r.Content.ReadAsStringAsync()}";
    }

    [Then("the request is refused as forbidden")]
    public void ThenForbidden()
    {
        Assert.NotNull(_last);
        Assert.Equal(HttpStatusCode.Forbidden, _last.StatusCode);
    }

    [Then("the request succeeds")]
    public void ThenSucceeds()
    {
        Assert.NotNull(_last);
        Assert.True(_last.IsSuccessStatusCode, $"got {(int)_last.StatusCode}");
    }

    // A household's members by name (the emulator accounts have no display name: their email).
    [Then("the members are exactly \"(.*)\"")]
    public async Task ThenExactly(string names)
    {
        Assert.NotNull(_last);
        Assert.Equal(HttpStatusCode.OK, _last.StatusCode);
        var list = await _last.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(names.Split(", "), list.EnumerateArray().Select(m => m.GetProperty("name").GetString()));
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
        _prevAnswer = _last is null ? null : await Answer(_last);
        _last?.Dispose();
        _last = await client.SendAsync(req);
    }

    public async Task<HttpClient> SignedIn(string email)
    {
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123"));
        return client;
    }

    // X's own household: their oldest membership, which /me without the header acts in.
    public async Task<Guid> HouseholdOf(string email)
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
        return await OwnHousehold.MeAsync(fx, client);
    }
}
