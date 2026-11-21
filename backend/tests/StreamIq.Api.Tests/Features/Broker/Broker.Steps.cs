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
using StreamIq.Api.Features.Broker;
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
    private TimeSpan? _authTimeout;   // the real one, while a scenario shortens it
    private System.Diagnostics.Stopwatch _opened = new();

    // For the tunnel telemetry steps (#390), which share this scenario's sockets.
    internal Guid Session => Guid.Parse(_session);
    internal WebSocket Browser => _browser;
    internal (Guid Id, WebSocket Ws) Gateway(string name)
    {
        return (_gateways[name].Id, _gateways[name].Ws);
    }

    [AfterScenario]
    public void Close()
    {
        foreach (var (_, ws, _) in _gateways.Values)
        {
            ws.Dispose();
        }

        _browser?.Dispose();
        if (_authTimeout is { } t)
        {
            BrowserSocket.AuthTimeout = t;
        }
    }

    [Given("\"([^\"]*)\" has an online gateway \"([^\"]*)\"")]
    public async Task GivenOnlineGateway(string email, string name)
    {
        using var client = await SignedIn(email);
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
        (await SignedIn(email)).Dispose();   // their own household, so the socket gets to "ready"
        await BrowserAuth(await IdToken(email));
        var ready = Assert.NotNull(await Receive(_browser));
        Assert.Equal("ready", ready.GetProperty("type").GetString());
        // This session's ICE servers (no TURN config in tests → STUN only).
        Assert.StartsWith("stun:", ready.GetProperty("iceServers")[0].GetProperty("urls")[0].GetString());
        await Send(_browser, new { type = "offer", gatewayId = _gateways[name].Id, sdp = new { type = "offer", sdp = "v=0 fake" } });
    }

    // An escaped lone surrogate parses but can't be written back out: relaying the offer
    // to the gateway throws after the broker registered the session.
    [When("\"([^\"]*)\" offers to gateway \"([^\"]*)\" an SDP the broker can't relay")]
    public async Task WhenOfferUnrelayable(string email, string name)
    {
        _offerer = email;
        (await SignedIn(email)).Dispose();
        await BrowserAuth(await IdToken(email));
        Assert.Equal("ready", Assert.NotNull(await Receive(_browser)).GetProperty("type").GetString());
        var raw = $$"""{"type":"offer","gatewayId":"{{_gateways[name].Id}}","sdp":"\ud800"}""";
        await _browser.SendAsync(Encoding.UTF8.GetBytes(raw), WebSocketMessageType.Text, true, CancellationToken.None);
        // The handler fails and drops the socket, which it disposes only after its finally ran.
        try
        {
            Assert.Null(await Receive(_browser));
        }
        catch (IOException) { }   // the test host reports the dropped socket this way
    }

    [Then("the broker holds no session for gateway \"([^\"]*)\"")]
    public async Task ThenNoSessionFor(string name)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (Hub.Sessions.Values.Any(s => s.GatewayId == _gateways[name].Id))
        {
            Assert.True(DateTime.UtcNow < deadline, "a session outlived its browser socket");
            await Task.Delay(10);
        }
    }

    // The broker ignores any household the browser names, on the socket or in the offer.
    [When("\"([^\"]*)\" offers to gateway \"([^\"]*)\" naming the household of \"([^\"]*)\"")]
    public async Task WhenOfferNaming(string email, string name, string owner)
    {
        using var ownerClient = await SignedIn(owner);
        var household = (await OwnHousehold.RawMeAsync(fx, ownerClient)).GetProperty("tenantId").GetString();
        _offerer = email;
        (await SignedIn(email)).Dispose();
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
        Assert.Equal((await OwnHousehold.RawMeAsync(fx, me)).GetProperty("userId").GetString(),
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
        var m = Assert.NotNull(await Receive(_browser));
        Assert.Equal("v=0 answer", m.GetProperty("sdp").GetProperty("sdp").GetString());
        // The tunnel id, for the browser's throughput PATCH (#390), is the session.
        Assert.Equal(_session, m.GetProperty("tunnel").GetString());
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
        var m = Assert.NotNull(await Receive(_browser));
        Assert.Equal("error", m.GetProperty("type").GetString());
        Assert.Equal("gateway offline or unknown", m.GetProperty("error").GetString());
    }

    // The hash nulled as RevokeGateway does, without its kill: the race where a socket
    // authenticated just before the revoke (or the kill missed it).
    [When("the credential of gateway \"([^\"]*)\" is revoked, its socket left open")]
    public async Task WhenRevokedOpen(string name)
    {
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        var id = _gateways[name].Id;
        Assert.Equal(1, await db.Gateways.IgnoreQueryFilters().Where(g => g.Id == id)
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.CredentialHash, (string?)null)));
        Assert.True(Hub.Gateways.ContainsKey(id));   // still routable as far as the broker's map goes
    }

    [When("gateway \"([^\"]*)\" sends a heartbeat")]
    public Task WhenHeartbeat(string name)
    {
        return Send(_gateways[name].Ws, new { type = "heartbeat", protocol = GatewaySocket.MinGatewayProtocol });
    }

    [Then("gateway \"([^\"]*)\" connecting with Authorization \"([^\"]*)\" is refused")]
    public async Task ThenHeaderRefused(string name, string header)
    {
        var ex = await Assert.ThrowsAnyAsync<Exception>(() => GatewayConnectWith(header.Replace("{credential}", _gateways[name].Credential)));
        Assert.Contains("401", ex.Message);
    }

    // Shortened so the scenario doesn't wait the real 10 s; AfterScenario restores it.
    [When("a browser opens a broker socket and sends nothing")]
    public async Task WhenSilentBrowser()
    {
        _authTimeout = BrowserSocket.AuthTimeout;
        BrowserSocket.AuthTimeout = TimeSpan.FromSeconds(1);
        _opened = System.Diagnostics.Stopwatch.StartNew();
        _browser = await fx.Factory.Server.CreateWebSocketClient()
            .ConnectAsync(new Uri(fx.Factory.Server.BaseAddress, "/api/broker/ws"), CancellationToken.None);
    }

    // A close frame with the reason (#555; an abort, a message or 5 s of silence fail: under
    // the real 10 s, so the shortened one is what fires). 100 ms of slack for timer granularity.
    [Then("the browser socket is closed as \"([^\"]*)\" after the auth timeout")]
    public async Task ThenClosedAfterTimeout(string reason)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        Assert.Equal(WebSocketMessageType.Close, (await _browser.ReceiveAsync(new byte[1024], cts.Token)).MessageType);
        Assert.Equal(reason, _browser.CloseStatusDescription);
        Assert.True(_opened.Elapsed >= BrowserSocket.AuthTimeout - TimeSpan.FromMilliseconds(100),
            $"closed after {_opened.Elapsed}, before the auth timeout");
    }

    [When("a browser opens a broker socket and first sends an offer")]
    public async Task WhenOfferFirst()
    {
        _browser = await fx.Factory.Server.CreateWebSocketClient()
            .ConnectAsync(new Uri(fx.Factory.Server.BaseAddress, "/api/broker/ws"), CancellationToken.None);
        await Send(_browser, new { type = "offer", gatewayId = Guid.NewGuid(), sdp = new { type = "offer", sdp = "v=0 fake" } });
    }

    [When("^a browser opens a broker socket and first sends (invalid JSON|a JSON array|a JSON number|a 9 KB frame)$")]
    public async Task WhenBadFirstFrame(string frame)
    {
        var text = frame switch
        {
            "invalid JSON" => "{not json",
            "a JSON array" => "[{\"type\":\"auth\"}]",
            "a JSON number" => "42",
            _ => $"{{\"type\":\"auth\",\"token\":\"{new string('x', 9 * 1024)}\"}}",   // over the 8 KB auth read
        };
        _browser = await fx.Factory.Server.CreateWebSocketClient()
            .ConnectAsync(new Uri(fx.Factory.Server.BaseAddress, "/api/broker/ws"), CancellationToken.None);
        await _browser.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);
    }

    // Signed up, never created or joined a household (#387).
    [When("\"([^\"]*)\", in no household, opens a broker socket")]
    public async Task WhenNoHousehold(string email)
    {
        await BrowserAuth(await IdToken(email));
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

    [Then("the browser socket is closed as \"([^\"]*)\"")]
    public async Task ThenClosedAs(string reason)
    {
        await ThenClosed();
        Assert.Equal(reason, _browser.CloseStatusDescription);
    }

    [When("gateway \"([^\"]*)\" disconnects")]
    public async Task WhenGatewayDisconnects(string name)
    {
        await _gateways[name].Ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
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
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));   // a gateway left open fails, not hangs
        var r = await ws.ReceiveAsync(new byte[1024], cts.Token);
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

    [Then("gateway \"([^\"]*)\" receives bye for that session")]
    public async Task ThenBye(string name)
    {
        var m = Assert.NotNull(await Receive(_gateways[name].Ws));
        Assert.Equal("bye", m.GetProperty("type").GetString());
        Assert.Equal(_session, m.GetProperty("session").GetString());
    }

    // The broker sends bye after removing the session, so no wait is needed here.
    [Then("the broker no longer holds that session")]
    public void ThenNoSession()
    {
        Assert.False(Hub.Sessions.ContainsKey(Session));
    }

    // The gateway socket's cleanup runs after the close: wait for it, then offer.
    [When("the broker no longer lists gateway \"([^\"]*)\"")]
    public async Task WhenGatewayGone(string name)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (Hub.Gateways.ContainsKey(_gateways[name].Id))
        {
            Assert.True(DateTime.UtcNow < deadline, "a disconnected gateway is still routable");
            await Task.Delay(10);
        }
    }

    [When("the browser sends an ICE candidate")]
    public Task WhenBrowserIce()
    {
        return Send(_browser, new { type = "ice", candidate = new { candidate = "candidate:browser" } });
    }

    [Then("gateway \"([^\"]*)\" receives that ICE candidate for that session")]
    public async Task ThenGatewayGetsIce(string name)
    {
        var m = Assert.NotNull(await Receive(_gateways[name].Ws));
        Assert.Equal("ice", m.GetProperty("type").GetString());
        Assert.Equal(_session, m.GetProperty("session").GetString());
        Assert.Equal("candidate:browser", m.GetProperty("candidate").GetProperty("candidate").GetString());
    }

    [When("gateway \"([^\"]*)\" sends an ICE candidate for that session")]
    public Task WhenGatewayIce(string name)
    {
        return Send(_gateways[name].Ws, new { type = "ice", session = _session, candidate = new { candidate = "candidate:gateway" } });
    }

    [Then("the browser receives that ICE candidate")]
    public async Task ThenBrowserGetsIce()
    {
        var m = Assert.NotNull(await Receive(_browser));
        Assert.Equal("ice", m.GetProperty("type").GetString());
        Assert.Equal("candidate:gateway", m.GetProperty("candidate").GetProperty("candidate").GetString());
    }

    // Valid JSON past the 64 KB cap: 64 KB of leading whitespace, then a real answer.
    // Were the broker to keep only the tail of an oversized message, the answer would get through;
    // the scenario then sends a normal message, so a broker that closes instead of skipping fails too.
    [When("gateway \"([^\"]*)\" sends an oversized answer for that session")]
    public Task WhenOversized(string name)
    {
        var json = new string(' ', 64 * 1024) + JsonSerializer.Serialize(new { type = "answer", session = _session, sdp = new { type = "answer", sdp = "v=0 answer" } });
        return _gateways[name].Ws.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, CancellationToken.None);
    }

    private Task<WebSocket> GatewayConnect(string credential)
    {
        return GatewayConnectWith($"Bearer {credential}");
    }

    private Task<WebSocket> GatewayConnectWith(string authorization)
    {
        var wsc = fx.Factory.Server.CreateWebSocketClient();
        wsc.ConfigureRequest = r => r.Headers.Authorization = authorization;
        return wsc.ConnectAsync(new Uri(fx.Factory.Server.BaseAddress, "/api/gateways/ws"), CancellationToken.None);
    }

    // With their own household (made on first use).
    internal async Task<HttpClient> SignedIn(string email)
    {
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", await IdToken(email));
        await OwnHousehold.MeAsync(fx, client);
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

    internal static Task Send(WebSocket ws, object msg)
    {
        return ws.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(msg)), WebSocketMessageType.Text, true, CancellationToken.None);
    }

    // Next JSON message (one complete frame), null on a Close frame; with quiet, null if
    // nothing arrives within a second, and a Close frame fails (#538): "receives nothing"
    // means the socket stayed open, so a broker that closes instead of dropping the message fails.
    private static async Task<JsonElement?> Receive(WebSocket ws, bool quiet = false)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(quiet ? 1 : 10));
        var buf = new byte[64 * 1024];
        try
        {
            var r = await ws.ReceiveAsync(buf, cts.Token);
            Assert.False(quiet && r.MessageType == WebSocketMessageType.Close,
                $"expected nothing, but the broker closed the socket ({ws.CloseStatus} \"{ws.CloseStatusDescription}\")");
            // One frame per message: a message the broker leaves unfinished never reaches a real peer.
            Assert.True(r.MessageType == WebSocketMessageType.Close || r.EndOfMessage, "message not marked complete");
            return r.MessageType == WebSocketMessageType.Close ? null : JsonDocument.Parse(buf.AsMemory(0, r.Count)).RootElement;
        }
        catch (OperationCanceledException) when (quiet)
        {
            return null;
        }
    }
}
