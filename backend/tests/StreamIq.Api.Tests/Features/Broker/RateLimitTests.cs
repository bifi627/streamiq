using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Broker;

[Collection("integration")]
public class RateLimitTests(IntegrationFixture fx)
{
    [Fact]
    public async Task Signaling_endpoints_are_limited_per_client_ip()
    {
        using var factory = fx.Factory.WithWebHostBuilder(b => b
            .UseSetting("STREAMIQ_SIGNALING_PER_MINUTE", "2")
            .UseSetting("STREAMIQ_CLIENT_IP_HEADER", "X-Real-IP"));
        using var client = factory.CreateClient();

        async Task<HttpStatusCode> Enroll(string ip)
        {
            using var rq = new HttpRequestMessage(HttpMethod.Post, "/gateways/enroll") { Content = JsonContent.Create(new { }) };
            rq.Headers.Add("X-Real-IP", ip);
            return (await client.SendAsync(rq)).StatusCode;
        }

        Assert.Equal(HttpStatusCode.BadRequest, await Enroll("203.0.113.1"));
        Assert.Equal(HttpStatusCode.BadRequest, await Enroll("203.0.113.1"));
        Assert.Equal(HttpStatusCode.TooManyRequests, await Enroll("203.0.113.1"));
        Assert.Equal(HttpStatusCode.BadRequest, await Enroll("203.0.113.2"));   // other IP, own budget

        // The broker socket shares the budget: the upgrade itself is refused.
        var wsc = factory.Server.CreateWebSocketClient();
        wsc.ConfigureRequest = r => r.Headers["X-Real-IP"] = "203.0.113.1";
        var ex = await Assert.ThrowsAnyAsync<Exception>(() =>
            wsc.ConnectAsync(new Uri(factory.Server.BaseAddress, "/broker/ws"), CancellationToken.None));
        Assert.Contains("429", ex.Message);
    }

    [Fact]
    public async Task A_browser_socket_flooding_messages_is_closed()
    {
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, "flood@x.test", "password123");
        var ws = await fx.Factory.Server.CreateWebSocketClient()
            .ConnectAsync(new Uri(fx.Factory.Server.BaseAddress, "/broker/ws"), CancellationToken.None);
        await Send(ws, $$"""{"type":"auth","token":"{{token}}"}""");

        var buf = new byte[64 * 1024];
        Assert.Equal(WebSocketMessageType.Text, (await ws.ReceiveAsync(buf, CancellationToken.None)).MessageType);   // ready
        for (var i = 0; i < 100; i++)   // burst is 50
        {
            await Send(ws, """{"type":"ice","candidate":{}}""");
        }

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Assert.Equal(WebSocketMessageType.Close, (await ws.ReceiveAsync(buf, cts.Token)).MessageType);
        Assert.Equal("rate limited", ws.CloseStatusDescription);
    }

    static Task Send(WebSocket ws, string json)
    {
        return ws.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, CancellationToken.None);
    }
}
