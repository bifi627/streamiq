using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Reqnroll;
using StreamIq.Api.Tests.Infrastructure;
using Hub = StreamIq.Api.Features.Broker.Broker;

namespace StreamIq.Api.Tests.Features.Broker;

[Binding]
public class BrokerSteps(IntegrationFixture fx)
{
    const string Fp = "sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

    private readonly Dictionary<string, (Guid Id, WebSocket Ws, string Credential)> _gateways = new();
    private HttpStatusCode _removal;
    // ! assigned by the browser-connect step before any step uses it
    private WebSocket _browser = null!;
    private string _session = "";
    private JsonElement _offer;
    private string _offerer = "";

    [AfterScenario]
    public void Close()
    {
        foreach (var (_, ws, _) in _gateways.Values)
        {
            ws.Dispose();
        }

        _browser?.Dispose();
    }

    [Given("\"([^\"]*)\" has an online gateway \"([^\"]*)\"")]
    public async Task GivenOnlineGateway(string email, string name)
    {
        using var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", await IdToken(email));
        var token = (await (await client.PostAsync("/api/gateways/enrollment-tokens", null)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("token").GetString();
        var enrolled = await (await client.PostAsJsonAsync("/api/gateways/enroll", new { token, fingerprint = Fp, name }))
            .Content.ReadFromJsonAsync<JsonElement>();
        var id = enrolled.GetProperty("gatewayId").GetGuid();

        var credential = enrolled.GetProperty("credential").GetString() ?? throw new InvalidOperationException("no credential");
        var ws = await GatewayConnect(credential);
        await Send(ws, new { type = "heartbeat", protocol = StreamIq.Api.Features.Broker.GatewaySocket.MinGatewayProtocol });
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!Hub.Gateways.ContainsKey(id))   // server registers on the first supported heartbeat
        {
            Assert.True(DateTime.UtcNow < deadline, "gateway not registered with the broker (heartbeat refused?)");
            await Task.Delay(10);
        }

        _gateways[name] = (id, ws, credential);
    }

    [When("\"([^\"]*)\" offers to gateway \"([^\"]*)\"")]
    public async Task WhenOffer(string email, string name)
    {
        _offerer = email;
        await BrowserAuth(await IdToken(email));
        var ready = Assert.NotNull(await Receive(_browser));
        Assert.Equal("ready", ready.GetProperty("type").GetString());
        // This session's ICE servers (no TURN config in tests → STUN only).
        Assert.StartsWith("stun:", ready.GetProperty("iceServers")[0].GetProperty("urls")[0].GetString());
        await Send(_browser, new { type = "offer", gatewayId = _gateways[name].Id, sdp = new { type = "offer", sdp = "v=0 fake" } });
    }

    // The broker ignores any household the browser names, on the socket or in the offer.
    [When("\"([^\"]*)\" offers to gateway \"([^\"]*)\" naming the household of \"([^\"]*)\"")]
    public async Task WhenOfferNaming(string email, string name, string owner)
    {
        using var ownerClient = await SignedIn(owner);
        var household = (await ownerClient.GetFromJsonAsync<JsonElement>("/api/me")).GetProperty("tenantId").GetString();
        _offerer = email;
        var wsc = fx.Factory.Server.CreateWebSocketClient();
        wsc.ConfigureRequest = r => r.Headers[StreamIq.Api.Auth.Households.Header] = household;
        _browser = await wsc.ConnectAsync(new Uri(fx.Factory.Server.BaseAddress, "/api/broker/ws"), CancellationToken.None);
        await Send(_browser, new { type = "auth", token = await IdToken(email), household });
        Assert.Equal("ready", Assert.NotNull(await Receive(_browser)).GetProperty("type").GetString());
        await Send(_browser, new { type = "offer", gatewayId = _gateways[name].Id, household, sdp = new { type = "offer", sdp = "v=0 fake" } });
    }

    [StepDefinition("gateway \"([^\"]*)\" receives the offer")]
    public async Task ThenGatewayGetsOffer(string name)
    {
        var m = Assert.NotNull(await Receive(_gateways[name].Ws));
        Assert.Equal("offer", m.GetProperty("type").GetString());
        Assert.Equal("v=0 fake", m.GetProperty("sdp").GetProperty("sdp").GetString());
        // The broker stamps the offering user's internal id (users.id, not the Firebase UID).
        using var me = await SignedIn(_offerer);
        Assert.Equal((await me.GetFromJsonAsync<JsonElement>("/api/me")).GetProperty("userId").GetString(),
            m.GetProperty("user").GetString());
        var session = m.GetProperty("session").GetString();
        Assert.NotNull(session);
        _session = session;
        _offer = m;
    }

    // The role is the offering user's role in the gateway's household (#194).
    [Then("gateway \"([^\"]*)\" receives the offer with role \"([^\"]*)\"")]
    public async Task ThenGatewayGetsOfferWithRole(string name, string role)
    {
        await ThenGatewayGetsOffer(name);
        Assert.Equal(role, _offer.GetProperty("role").GetString());
    }

    [When("gateway \"([^\"]*)\" answers that session")]
    public async Task WhenAnswer(string name)
    {
        await Send(_gateways[name].Ws, new { type = "answer", session = _session, sdp = new { type = "answer", sdp = "v=0 answer" } });
    }

    [Then("the browser receives the answer")]
    public async Task ThenBrowserGetsAnswer()
    {
        Assert.Equal("v=0 answer", Assert.NotNull(await Receive(_browser)).GetProperty("sdp").GetProperty("sdp").GetString());
    }

    [Then("the browser receives nothing")]
    public async Task ThenBrowserNothing()
    {
        Assert.Null(await Receive(_browser, quiet: true));
    }

    [Then("gateway \"([^\"]*)\" receives nothing")]
    public async Task ThenGatewayNothing(string name)
    {
        Assert.Null(await Receive(_gateways[name].Ws, quiet: true));
    }

    [Then("the browser is told the gateway is offline or unknown")]
    public async Task ThenBrowserError()
    {
        Assert.Equal("error", Assert.NotNull(await Receive(_browser)).GetProperty("type").GetString());
    }

    [When("a browser authenticates with token \"([^\"]*)\"")]
    public Task WhenBadToken(string token)
    {
        return BrowserAuth(token);
    }

    [Then("the browser socket is closed")]
    public async Task ThenClosed()
    {
        var r = await _browser.ReceiveAsync(new byte[1024], CancellationToken.None);
        Assert.Equal(WebSocketMessageType.Close, r.MessageType);
    }

    [When("\"([^\"]*)\" removes gateway \"([^\"]*)\"")]
    public async Task WhenRemove(string email, string name)
    {
        using var client = await SignedIn(email);
        _removal = (await client.DeleteAsync($"/api/gateways/{_gateways[name].Id}")).StatusCode;
    }

    [Then("the removal succeeds")]
    public void ThenRemoved()
    {
        Assert.Equal(HttpStatusCode.NoContent, _removal);
    }

    [Then("the removal is refused as not found")]
    public void ThenRemovalNotFound()
    {
        Assert.Equal(HttpStatusCode.NotFound, _removal);
    }

    [Then("gateway \"([^\"]*)\" is disconnected as \"([^\"]*)\"")]
    public async Task ThenGatewayDisconnected(string name, string reason)
    {
        var ws = _gateways[name].Ws;
        var r = await ws.ReceiveAsync(new byte[1024], CancellationToken.None);
        Assert.Equal(WebSocketMessageType.Close, r.MessageType);
        Assert.Equal(reason, ws.CloseStatusDescription);
    }

    [Then("gateway \"([^\"]*)\" can no longer connect")]
    public async Task ThenGatewayRejected(string name)
    {
        var ex = await Assert.ThrowsAnyAsync<Exception>(() => GatewayConnect(_gateways[name].Credential));
        Assert.Contains("401", ex.Message);
    }

    [Then("\"([^\"]*)\" no longer lists gateway \"([^\"]*)\"")]
    public async Task ThenNotListed(string email, string name)
    {
        using var client = await SignedIn(email);
        var list = await client.GetFromJsonAsync<JsonElement>("/api/gateways");
        Assert.DoesNotContain(list.EnumerateArray(), g => g.GetProperty("id").GetGuid() == _gateways[name].Id);
    }

    private Task<WebSocket> GatewayConnect(string credential)
    {
        var wsc = fx.Factory.Server.CreateWebSocketClient();
        wsc.ConfigureRequest = r => r.Headers.Authorization = $"Bearer {credential}";
        return wsc.ConnectAsync(new Uri(fx.Factory.Server.BaseAddress, "/api/gateways/ws"), CancellationToken.None);
    }

    private async Task<HttpClient> SignedIn(string email)
    {
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", await IdToken(email));
        return client;
    }

    private Task<string> IdToken(string email)
    {
        return TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123");
    }

    private async Task BrowserAuth(string token)
    {
        _browser = await fx.Factory.Server.CreateWebSocketClient()
            .ConnectAsync(new Uri(fx.Factory.Server.BaseAddress, "/api/broker/ws"), CancellationToken.None);
        await Send(_browser, new { type = "auth", token });
    }

    private static Task Send(WebSocket ws, object msg)
    {
        return ws.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(msg)), WebSocketMessageType.Text, true, CancellationToken.None);
    }

    // Next JSON message; with quiet, null if nothing arrives within a second.
    private static async Task<JsonElement?> Receive(WebSocket ws, bool quiet = false)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(quiet ? 1 : 10));
        var buf = new byte[64 * 1024];
        try
        {
            var r = await ws.ReceiveAsync(buf, cts.Token);
            return r.MessageType == WebSocketMessageType.Close ? null : JsonDocument.Parse(buf.AsMemory(0, r.Count)).RootElement;
        }
        catch (OperationCanceledException) when (quiet)
        {
            return null;
        }
    }
}
