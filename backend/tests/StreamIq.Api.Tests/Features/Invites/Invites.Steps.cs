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

namespace StreamIq.Api.Tests.Features.Invites;

/// "The household of X" / "their own household" = X's first household (their oldest,
/// what /me answers without the header). One invite per scenario.
[Binding]
public class InvitesSteps(IntegrationFixture fx)
{
    private string? _token;
    private Guid _inviteId;
    private HttpResponseMessage? _last;
    private HttpResponseMessage Last => _last ?? throw new InvalidOperationException("no request sent yet");

    [AfterScenario]
    public void Dispose()
    {
        _last?.Dispose();
    }

    [Given("\"(.*)\" has a household with gateway \"(.*)\"")]
    public async Task GivenGateway(string email, string name)
    {
        var tenant = await HouseholdOf(email);
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        db.Gateways.Add(new Gateway { TenantId = tenant, Name = name, CredentialHash = Guid.NewGuid().ToString() });
        await db.SaveChangesAsync();
    }

    [Given("\"(.*)\" created an invite")]
    public async Task GivenInvite(string email)
    {
        await Send(email, HttpMethod.Post, "/api/invites", null);
        Assert.Equal(HttpStatusCode.OK, Last.StatusCode);
        var body = await Last.Content.ReadFromJsonAsync<JsonElement>();
        _token = body.GetProperty("token").GetString();
        _inviteId = body.GetProperty("id").GetGuid();
    }

    [Given("the invite has expired")]
    public async Task GivenExpired()
    {
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        Assert.Equal(1, await db.Invites.IgnoreQueryFilters().Where(i => i.Id == _inviteId)
            .ExecuteUpdateAsync(s => s.SetProperty(i => i.ExpiresAt, DateTimeOffset.UtcNow.AddSeconds(-1))));
    }

    [Given("\"(.*)\" accepted it")]
    [When("\"(.*)\" accepts the invite")]
    public Task WhenAccepts(string email)
    {
        return Send(email, HttpMethod.Post, "/api/invites/accept", null, new { token = _token });
    }

    [When("\"(.*)\" accepts the invite token \"(.*)\"")]
    public Task WhenAcceptsToken(string email, string token)
    {
        return Send(email, HttpMethod.Post, "/api/invites/accept", null, new { token });
    }

    [When("\"(.*)\" previews the invite")]
    public Task WhenPreviews(string email)
    {
        return Send(email, HttpMethod.Post, "/api/invites/preview", null, new { token = _token });
    }

    [When("\"(.*)\" revokes the invite")]
    public Task WhenRevokes(string email)
    {
        return Send(email, HttpMethod.Delete, $"/api/invites/{_inviteId}", null);
    }

    [When("\"(.*)\" revokes the invite in the household of \"(.*)\"")]
    public async Task WhenRevokesIn(string email, string owner)
    {
        await Send(email, HttpMethod.Delete, $"/api/invites/{_inviteId}", await HouseholdOf(owner));
    }

    [When("\"(.*)\" creates an invite in the household of \"(.*)\"")]
    public async Task WhenCreatesIn(string email, string owner)
    {
        await Send(email, HttpMethod.Post, "/api/invites", await HouseholdOf(owner));
    }

    [When("\"(.*)\" lists invites in the household of \"(.*)\"")]
    public async Task WhenListsIn(string email, string owner)
    {
        await Send(email, HttpMethod.Get, "/api/invites", await HouseholdOf(owner));
    }

    [Then("the preview names \"(.*)\" and says not a member")]
    public async Task ThenPreview(string name)
    {
        var body = await Ok();
        Assert.Equal(name, body.GetProperty("name").GetString());
        Assert.False(body.GetProperty("member").GetBoolean());
    }

    [Then("the preview says already a member")]
    public async Task ThenPreviewMember()
    {
        Assert.True((await Ok()).GetProperty("member").GetBoolean());
    }

    [Then("the answer is the household of \"(.*)\"")]
    public async Task ThenHousehold(string owner)
    {
        Assert.Equal(await HouseholdOf(owner), (await Ok()).GetProperty("householdId").GetGuid());
    }

    [Then("the invite is refused as not found")]
    public void ThenNotFound()
    {
        Assert.Equal(HttpStatusCode.NotFound, Last.StatusCode);
    }

    [Then("the invite is refused as forbidden")]
    public void ThenForbidden()
    {
        Assert.Equal(HttpStatusCode.Forbidden, Last.StatusCode);
    }

    [Then("\"(.*)\" is \"(.*)\" of their own household and \"(.*)\" of the household of \"(.*)\"")]
    public async Task ThenRoles(string email, string ownRole, string role, string owner)
    {
        Assert.Equal([(await HouseholdOf(email), ownRole), (await HouseholdOf(owner), role)], await Memberships(email));
    }

    [Then("\"(.*)\" is only in their own household")]
    public async Task ThenOnlyOwn(string email)
    {
        Assert.Equal([(await HouseholdOf(email), Membership.Admin)], await Memberships(email));
    }

    [Then("\"(.*)\" sees exactly gateway \"(.*)\" in the household of \"(.*)\"")]
    public async Task ThenSeesIn(string email, string name, string owner)
    {
        await Send(email, HttpMethod.Get, "/api/gateways", await HouseholdOf(owner));
        Assert.Equal([name], (await Ok()).EnumerateArray().Select(g => g.GetProperty("name").GetString()));
    }

    [Then("\"(.*)\" sees exactly gateway \"(.*)\" without naming a household")]
    public async Task ThenSees(string email, string name)
    {
        await Send(email, HttpMethod.Get, "/api/gateways", null);
        Assert.Equal([name], (await Ok()).EnumerateArray().Select(g => g.GetProperty("name").GetString()));
    }

    [Then("\"(.*)\" has no pending invites")]
    public Task ThenNoPending(string email)
    {
        return ThenPending(email, 0);
    }

    [Given("\"(.*)\" lists (\\d+) pending invites?")]
    [Then("\"(.*)\" lists (\\d+) pending invites?")]
    public async Task ThenPending(string email, int count)
    {
        await Send(email, HttpMethod.Get, "/api/invites", null);
        Assert.Equal(count, (await Ok()).GetArrayLength());
    }

    private async Task<JsonElement> Ok()
    {
        Assert.True(Last.IsSuccessStatusCode, $"got {(int)Last.StatusCode}");
        return await Last.Content.ReadFromJsonAsync<JsonElement>();
    }

    private async Task Send(string email, HttpMethod method, string path, Guid? household, object? body = null)
    {
        using var client = await SignedIn(email);
        using var req = new HttpRequestMessage(method, path);
        if (household is not null)
        {
            req.Headers.TryAddWithoutValidation(Households.Header, household.ToString());
        }
        if (body is not null)
        {
            req.Content = JsonContent.Create(body);
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

    private async Task<Guid> HouseholdOf(string email)
    {
        return (await Me(email)).GetProperty("tenantId").GetGuid();
    }

    private async Task<(Guid, string?)[]> Memberships(string email)
    {
        return (await Me(email)).GetProperty("memberships").EnumerateArray()
            .Select(m => (m.GetProperty("id").GetGuid(), m.GetProperty("role").GetString())).ToArray();
    }

    private async Task<JsonElement> Me(string email)
    {
        using var client = await SignedIn(email);
        return await client.GetFromJsonAsync<JsonElement>("/api/me");
    }
}
