using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
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
    private bool _refused;
    private readonly Dictionary<string, string> _credentials = new();

    private async Task<HttpClient> SignIn(string email)
    {
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123");
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
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

    [Given("\"(.*)\" has an enrolled gateway \"(.*)\"")]
    public async Task GivenEnrolled(string email, string name)
    {
        var res = await Enroll(await CreateToken(email), name);
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        var credential = body.GetProperty("credential").GetString();
        Assert.NotNull(credential);
        _credentials[name] = credential;
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

    private async Task<WebSocket> Connect(string credential)
    {
        var ws = fx.Factory.Server.CreateWebSocketClient();
        ws.ConfigureRequest = r => r.Headers.Authorization = $"Bearer {credential}";
        return await ws.ConnectAsync(new Uri(fx.Factory.Server.BaseAddress, "/api/gateways/ws"), CancellationToken.None);
    }

    [When("a gateway connects with credential \"(.*)\"")]
    public async Task WhenConnect(string credential)
    {
        try
        {
            (await Connect(credential)).Dispose();
        }
        catch (InvalidOperationException)
        {
            _refused = true;
        }   // TestServer: handshake got a non-101 status
    }

    [Then("the gateway connection is refused")]
    public void ThenRefused()
    {
        Assert.True(_refused);
    }

    [When("gateway \"(.*)\" heartbeats with LAN URL \"(.*)\" and version \"(.*)\"")]
    public async Task WhenHeartbeat(string name, string lanUrl, string version)
    {
        using var ws = await Connect(_credentials[name]);
        var msg = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { type = "heartbeat", lanUrl, version }));
        await ws.SendAsync(msg, WebSocketMessageType.Text, true, CancellationToken.None);
        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);   // server finishes the frame first
    }

    [When("gateway \"(.*)\" heartbeats a status with Jellyfin token \"(.*)\", (\\d+) paired clients and an extra field \"(.*)\"")]
    public async Task WhenHeartbeatStatus(string name, string token, int paired, string extra)
    {
        using var ws = await Connect(_credentials[name]);
        var hb = new Dictionary<string, object>
        {
            ["type"] = "heartbeat",
            ["version"] = "1.5.0",
            ["os"] = "windows",
            ["arch"] = "amd64",
            ["startedAt"] = "2026-11-10T08:00:00Z",
            ["pairedClients"] = paired,
            ["activeSessions"] = 1,
            ["jellyfin"] = new { reachable = true, version = "10.11.2", untested = false, token },
            [extra] = new[] { "Jo's iPhone" },   // a gateway must not get names into our DB
        };
        await ws.SendAsync(JsonSerializer.SerializeToUtf8Bytes(hb), WebSocketMessageType.Text, true, CancellationToken.None);
        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
    }

    [Then("\"(.*)\" sees \"(.*)\" with Jellyfin token \"(.*)\" and (\\d+) paired clients")]
    public async Task ThenStatus(string email, string name, string token, int paired)
    {
        var s = (await Gateway(email, name)).GetProperty("status");
        Assert.Equal(token, s.GetProperty("jellyfin").GetProperty("token").GetString());
        Assert.Equal(paired, s.GetProperty("pairedClients").GetInt32());
        Assert.Equal("windows", s.GetProperty("os").GetString());
    }

    [Then("\"(.*)\" sees no \"(.*)\" in the status of \"(.*)\"")]
    public async Task ThenNoField(string email, string field, string name)
    {
        Assert.False((await Gateway(email, name)).GetProperty("status").TryGetProperty(field, out _));
    }

    private async Task<JsonElement> Gateway(string email, string name)
    {
        return (await Gateways(email)).EnumerateArray().Single(d => d.GetProperty("name").GetString() == name);
    }

    [Then("\"(.*)\" sees \"(.*)\" online at \"(.*)\"")]
    public async Task ThenOnline(string email, string name, string lanUrl)
    {
        var d = await Gateway(email, name);
        Assert.True(d.GetProperty("online").GetBoolean());
        Assert.Equal(lanUrl, d.GetProperty("lanUrl").GetString());
    }

    [Then("\"(.*)\" sees \"(.*)\" at version \"(.*)\"")]
    public async Task ThenVersion(string email, string name, string version)
    {
        Assert.Equal(version, (await Gateway(email, name)).GetProperty("version").GetString());
    }

    [Then("\"(.*)\" sees \"(.*)\" offline")]
    public async Task ThenOffline(string email, string name)
    {
        Assert.False((await Gateway(email, name)).GetProperty("online").GetBoolean());
    }
}
