using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using StreamIq.Api.Auth;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Me;

[Collection("integration")]
public class GetMeTests(IntegrationFixture fx)
{
    private async Task<HttpClient> SignedInClient(string email)
    {
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123");
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    [Fact]
    public async Task Me_returns_the_signed_in_user_and_tenant()
    {
        await fx.ResetAsync();
        using var client = await SignedInClient("me@x.test");
        var body = await OwnHousehold.MeAsync(client);
        Assert.False(string.IsNullOrEmpty(body.GetProperty("userId").GetString()));
        Assert.False(string.IsNullOrEmpty(body.GetProperty("tenantId").GetString()));
        Assert.False(body.TryGetProperty("email", out _)); // #65: no PII in our DB or API; Firebase owns it
    }

    // #387: signed up, no household yet. /me works and says so; household-scoped
    // endpoints answer like for a non-member, so the web app shows the no-household screen.
    [Fact]
    public async Task A_user_with_no_household_gets_me_and_nothing_household_scoped()
    {
        await fx.ResetAsync();
        using var client = await SignedInClient("nohome@x.test");

        var me = await client.GetFromJsonAsync<JsonElement>("/api/me");
        Assert.False(string.IsNullOrEmpty(me.GetProperty("userId").GetString()));
        Assert.Equal(JsonValueKind.Null, me.GetProperty("tenantId").ValueKind);
        Assert.Empty(me.GetProperty("memberships").EnumerateArray());

        foreach (var (method, path) in new[]
        {
            (HttpMethod.Get, "/api/gateways"), (HttpMethod.Post, "/api/gateways/enrollment-tokens"),
            (HttpMethod.Get, "/api/members"), (HttpMethod.Get, "/api/invites"), (HttpMethod.Post, "/api/invites"),
            (HttpMethod.Put, "/api/households/current/name"), (HttpMethod.Post, "/api/tunnels"),
        })
        {
            using var res = await client.SendAsync(new HttpRequestMessage(method, path));
            Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
            Assert.Equal(["1"], res.Headers.GetValues(Households.NotMemberHeader));
        }
    }

    [Fact]
    public async Task Creating_a_household_makes_the_user_its_admin_and_another_one_adds_a_second()
    {
        await fx.ResetAsync();
        using var client = await SignedInClient("creator@x.test");

        using var first = await client.PostAsync("/api/households", null);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var id = (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("householdId").GetGuid();
        var me = await client.GetFromJsonAsync<JsonElement>("/api/me");
        Assert.Equal(id, me.GetProperty("tenantId").GetGuid());
        var m = Assert.Single(me.GetProperty("memberships").EnumerateArray());
        Assert.Equal((id, "admin"), (m.GetProperty("id").GetGuid(), m.GetProperty("role").GetString()));
        Assert.Equal(JsonValueKind.Null, m.GetProperty("name").ValueKind);   // named later (RenameHousehold)
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/gateways")).StatusCode);

        using var second = await client.PostAsync("/api/households", null);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Equal(2, (await client.GetFromJsonAsync<JsonElement>("/api/me")).GetProperty("memberships").GetArrayLength());
    }

    [Fact]
    public async Task Creating_a_household_needs_a_signed_in_user()
    {
        using var client = fx.Factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/api/households", null)).StatusCode);
    }
}
