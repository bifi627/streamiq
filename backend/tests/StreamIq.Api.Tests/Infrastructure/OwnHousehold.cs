using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace StreamIq.Api.Tests.Infrastructure;

/// Sign-up makes no household (#387). Most scenarios still mean "X's own household":
/// this creates it on X's first /me (as its admin, like the web app's Create button),
/// so "the household of X" keeps meaning what it did. Scenarios about having no
/// household read /me raw instead.
public static class OwnHousehold
{
    public static async Task<JsonElement> MeAsync(HttpClient client)
    {
        var me = await client.GetFromJsonAsync<JsonElement>("/api/me");
        if (me.GetProperty("memberships").GetArrayLength() > 0)
        {
            return me;
        }
        using var res = await client.PostAsync("/api/households", null);
        res.EnsureSuccessStatusCode();
        return await client.GetFromJsonAsync<JsonElement>("/api/me");
    }

    /// For tests that only hold an ID token (broker sockets).
    public static async Task EnsureAsync(IntegrationFixture fx, string idToken)
    {
        using var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", idToken);
        await MeAsync(client);
    }
}
