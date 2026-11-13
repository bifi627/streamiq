using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Reqnroll;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Members;

/// "The household of X" = X's own household (their oldest at first mention, then
/// remembered for the scenario, so it stays put after X leaves it).
[Binding]
public partial class MembersSteps(IntegrationFixture fx)
{
    private readonly Dictionary<string, Guid> _households = new();
    private readonly List<HttpStatusCode> _race = [];
    private HttpResponseMessage? _last;
    private HttpResponseMessage Last => _last ?? throw new InvalidOperationException("no request sent yet");

    [AfterScenario]
    public void Dispose()
    {
        _last?.Dispose();
    }

    [Given("\"(.*)\" is an admin of the household of \"(.*)\"")]
    public async Task GivenAdmin(string email, string owner)
    {
        var (user, tenant) = ((await Me(email, null)).GetProperty("userId").GetGuid(), await HouseholdOf(owner));
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        db.Memberships.Add(new Membership { TenantId = tenant, UserId = user, Role = Membership.Admin });
        await db.SaveChangesAsync();
    }

    [When("\"(.*)\" lists the members of the household of \"(.*)\"")]
    public async Task WhenLists(string email, string owner)
    {
        _last?.Dispose();
        _last = await Send(email, HttpMethod.Get, "/api/members", await HouseholdOf(owner));
    }

    [When("\"(.*)\" opens the invites of the household of \"(.*)\"")]
    public async Task WhenInvites(string email, string owner)
    {
        _last?.Dispose();
        _last = await Send(email, HttpMethod.Get, "/api/invites", await HouseholdOf(owner));
    }

    [When("\"(.*)\" removes \"(.*)\" from the household of \"(.*)\"")]
    public async Task WhenRemoves(string email, string target, string owner)
    {
        var id = await UserIdOf(target);
        _last?.Dispose();
        _last = await Send(email, HttpMethod.Delete, $"/api/members/{id}", await HouseholdOf(owner));
    }

    [Given("\"(.*)\" made \"(.*)\" \"(.*)\" in the household of \"(.*)\"")]
    [When("\"(.*)\" makes \"(.*)\" \"(.*)\" in the household of \"(.*)\"")]
    public async Task WhenMakes(string email, string target, string role, string owner)
    {
        var id = await UserIdOf(target);
        _last?.Dispose();
        _last = await Send(email, HttpMethod.Put, $"/api/members/{id}/role", await HouseholdOf(owner), new { role });
    }

    [When("\"(.*)\" and \"(.*)\" demote each other at once in the household of \"(.*)\"")]
    public async Task WhenRace(string a, string b, string owner)
    {
        var (idA, idB, h) = (await UserIdOf(a), await UserIdOf(b), await HouseholdOf(owner));
        var results = await Task.WhenAll(
            Send(a, HttpMethod.Put, $"/api/members/{idB}/role", h, new { role = Membership.Member }),
            Send(b, HttpMethod.Put, $"/api/members/{idA}/role", h, new { role = Membership.Member }));
        _race.AddRange(results.Select(r => r.StatusCode));
        foreach (var r in results)
        {
            r.Dispose();
        }
    }

    // The loser is 409 (the guard, under the tenant-row lock) or 403 (its request
    // was authenticated after the winner's demotion committed): either way refused.
    [Then("exactly one demotion succeeds and the household keeps one admin")]
    public async Task ThenRace()
    {
        Assert.Single(_race, HttpStatusCode.NoContent);
        Assert.Contains(_race, s => s is HttpStatusCode.Conflict or HttpStatusCode.Forbidden);
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        db.CurrentTenantId = await HouseholdOf("alice@home.test");
        Assert.Equal(1, await db.Memberships.CountAsync(m => m.Role == Membership.Admin));
    }

    [Then(@"the answer is (\d+)")]
    public void ThenStatus(int status)
    {
        Assert.Equal(status, (int)Last.StatusCode);
    }

    [Then(@"the answer is (\d+) saying ""(.*)""")]
    public async Task ThenStatusSaying(int status, string text)
    {
        ThenStatus(status);
        Assert.Contains(text, (await Last.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
    }

    [Then("the members are (.*)")]
    public async Task ThenMembers(string list)
    {
        ThenStatus(200);
        var want = PairRe().Matches(list).Select(m => ((string?)m.Groups[1].Value, (string?)m.Groups[2].Value)).ToList();
        var body = await Last.Content.ReadFromJsonAsync<JsonElement>();
        var got = body.EnumerateArray().Select(m => (m.GetProperty("email").GetString(), m.GetProperty("role").GetString())).ToList();
        Assert.Equal(want, got);
        Assert.All(body.EnumerateArray(), m => Assert.NotEqual(default, m.GetProperty("joinedAt").GetDateTimeOffset()));
    }

    [Then("\"(.*)\" still has their own household, not the one of \"(.*)\"")]
    public async Task ThenOwn(string email, string owner)
    {
        var m = Assert.Single((await Me(email, null)).GetProperty("memberships").EnumerateArray());
        Assert.Equal(Membership.Admin, m.GetProperty("role").GetString());
        Assert.NotEqual(await HouseholdOf(owner), m.GetProperty("id").GetGuid());
    }

    [Given("\"(.*)\" created an invite in the household of \"(.*)\"")]
    public async Task GivenInvite(string email, string owner)
    {
        using var res = await Send(email, HttpMethod.Post, "/api/invites", await HouseholdOf(owner));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Then(@"the household of ""(.*)"" has (\d+) pending invites?")]
    public async Task ThenInvites(string owner, int count)
    {
        using var res = await Send(owner, HttpMethod.Get, "/api/invites", await HouseholdOf(owner));
        Assert.Equal(count, (await res.Content.ReadFromJsonAsync<JsonElement>()).GetArrayLength());
    }

    [Then("\"(.*)\" is admin of exactly one new household")]
    public async Task ThenNew(string email)
    {
        var me = await Me(email, null);
        var m = Assert.Single(me.GetProperty("memberships").EnumerateArray());
        Assert.Equal(Membership.Admin, m.GetProperty("role").GetString());
        Assert.DoesNotContain(m.GetProperty("id").GetGuid(), _households.Values);
    }

    [GeneratedRegex("\"(.*?)\" as \"(.*?)\"")]
    private static partial Regex PairRe();

    private async Task<Guid> HouseholdOf(string email)
    {
        if (!_households.TryGetValue(email, out var h))
        {
            _households[email] = h = (await Me(email, null)).GetProperty("tenantId").GetGuid();
        }
        return h;
    }

    private async Task<Guid> UserIdOf(string email)
    {
        return (await Me(email, null)).GetProperty("userId").GetGuid();
    }

    private async Task<JsonElement> Me(string email, Guid? household)
    {
        using var res = await Send(email, HttpMethod.Get, "/api/me", household);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    private async Task<HttpResponseMessage> Send(string email, HttpMethod method, string path, Guid? household, object? body = null)
    {
        using var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123"));
        using var req = new HttpRequestMessage(method, path);
        if (household is not null)
        {
            req.Headers.TryAddWithoutValidation(Households.Header, household.ToString());
        }
        if (body is not null)
        {
            req.Content = JsonContent.Create(body);
        }
        return await client.SendAsync(req);
    }
}
