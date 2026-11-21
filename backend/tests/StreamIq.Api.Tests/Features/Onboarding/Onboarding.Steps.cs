using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Reqnroll;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Onboarding;

[Binding]
public class OnboardingSteps(IntegrationFixture fx)
{
    const string Fp = "sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

    private string _token = "";
    private HttpStatusCode _enrollStatus;

    private async Task<HttpClient> SignIn(string email)
    {
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123");
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        await OwnHousehold.MeAsync(fx, client);
        return client;
    }

    private async Task<string> CreateToken(string email)
    {
        using var client = await SignIn(email);
        var res = await client.PostAsync("/api/gateways/enrollment-tokens", null);
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        var token = body.GetProperty("token").GetString();
        Assert.NotNull(token);
        Assert.Contains(token, body.GetProperty("installCommand").GetString());
        return token;
    }

    private async Task<HttpResponseMessage> Enroll(string token, string name = "box")
    {
        using var client = fx.Factory.CreateClient();
        return await client.PostAsJsonAsync("/api/gateways/enroll", new { token, fingerprint = Fp, name });
    }

    private async Task<JsonElement> Gateways(string email)
    {
        using var client = await SignIn(email);
        return await client.GetFromJsonAsync<JsonElement>("/api/gateways");
    }

    [Given("\"(.*)\" created an enrollment token")]
    public async Task GivenToken(string email)
    {
        _token = await CreateToken(email);
    }

    [Given("the token has expired")]
    public async Task GivenExpired()
    {
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        await db.EnrollmentTokens.IgnoreQueryFilters()
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.ExpiresAt, DateTimeOffset.UtcNow.AddMinutes(-1)));
    }

    [When("a gateway enrolls with that token")]
    public async Task WhenEnroll()
    {
        _enrollStatus = (await Enroll(_token)).StatusCode;
    }

    [Then("the enrollment is accepted")]
    public void ThenAccepted()
    {
        Assert.Equal(HttpStatusCode.OK, _enrollStatus);
    }

    [Then("the enrollment is rejected")]
    public void ThenRejected()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, _enrollStatus);
    }

    [Then("\"(.*)\" sees ([0-9]+) gateways?")]
    public async Task ThenSeesCount(string email, int n)
    {
        Assert.Equal(n, (await Gateways(email)).GetArrayLength());
    }
}
