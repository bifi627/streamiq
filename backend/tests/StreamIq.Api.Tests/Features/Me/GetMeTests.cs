using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
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
        var body = await client.GetFromJsonAsync<JsonElement>("/api/me");
        Assert.False(string.IsNullOrEmpty(body.GetProperty("userId").GetString()));
        Assert.False(string.IsNullOrEmpty(body.GetProperty("tenantId").GetString()));
        Assert.False(body.TryGetProperty("email", out _)); // #65: no PII in our DB or API; Firebase owns it
    }
}
