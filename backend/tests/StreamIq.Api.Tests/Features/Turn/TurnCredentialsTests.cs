using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using StreamIq.Api.Features.Turn;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Turn;

[Collection("integration")]
public class TurnCredentialsTests(IntegrationFixture fx)
{
    [Fact]
    public async Task Dev_TURN_credentials_are_short_lived_TURN_REST_creds()
    {
        var cfg = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["STREAMIQ_TURN_URLS"] = "turn:127.0.0.1:3478?transport=udp",
            ["STREAMIQ_TURN_SECRET"] = "s3cret",
        }).Build();

        var issued = await TurnCredentials.IssueAsync(cfg, new HttpClient(), "user-1", CancellationToken.None);

        Assert.Null(issued.RevokeUsername);   // coturn REST creds can't be revoked, only expire
        var turn = issued.IceServers[1] ?? throw new InvalidOperationException("no TURN entry");
        var username = (string?)turn["username"] ?? throw new InvalidOperationException("no username");
        var expiry = DateTimeOffset.FromUnixTimeSeconds(long.Parse(username.Split(':')[0]));
        Assert.InRange(expiry - DateTimeOffset.UtcNow, TurnCredentials.Ttl - TimeSpan.FromMinutes(1), TurnCredentials.Ttl);
        Assert.EndsWith(":user-1", username);
        Assert.Equal(Convert.ToBase64String(HMACSHA1.HashData("s3cret"u8.ToArray(), Encoding.UTF8.GetBytes(username))),
            (string?)turn["credential"]);
    }

    [Fact]
    public async Task Each_broker_session_gets_its_own_Cloudflare_credential_revoked_when_it_ends()
    {
        var cloudflare = new FakeCloudflare();
        using var factory = fx.Factory.WithWebHostBuilder(b => b
            .UseSetting("CLOUDFLARE_TURN_KEY_ID", "key1")
            .UseSetting("CLOUDFLARE_TURN_API_TOKEN", "tok")
            .ConfigureTestServices(s => s.ConfigureHttpClientDefaults(h => h.ConfigurePrimaryHttpMessageHandler(() => cloudflare))));
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, "turn@x.test", "password123");

        async Task<string> Session()
        {
            var ws = await factory.Server.CreateWebSocketClient()
                .ConnectAsync(new Uri(factory.Server.BaseAddress, "/api/broker/ws"), CancellationToken.None);
            await ws.SendAsync(Encoding.UTF8.GetBytes($$"""{"type":"auth","token":"{{token}}"}"""),
                WebSocketMessageType.Text, true, CancellationToken.None);
            var buf = new byte[64 * 1024];
            var r = await ws.ReceiveAsync(buf, CancellationToken.None);
            var ready = JsonDocument.Parse(buf.AsMemory(0, r.Count)).RootElement;
            var username = ready.GetProperty("iceServers")[1].GetProperty("username").GetString() ?? throw new InvalidOperationException("no username");
            await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
            return username;
        }

        var first = await Session();
        var second = await Session();

        Assert.NotEqual(first, second);
        Assert.Contains("/v1/turn/keys/key1/credentials/generate-ice-servers", cloudflare.Calls);
        await WaitFor(() => cloudflare.Calls.Contains($"/v1/turn/keys/key1/credentials/{second}/revoke"));
        Assert.Contains($"/v1/turn/keys/key1/credentials/{first}/revoke", cloudflare.Calls);
    }

    [Fact]
    public async Task A_timed_out_TURN_provider_falls_back_to_STUN_instead_of_closing_the_session()
    {
        var cloudflare = new FakeCloudflare { TimeOut = true };
        using var factory = fx.Factory.WithWebHostBuilder(b => b
            .UseSetting("CLOUDFLARE_TURN_KEY_ID", "key1")
            .UseSetting("CLOUDFLARE_TURN_API_TOKEN", "tok")
            .ConfigureTestServices(s => s.ConfigureHttpClientDefaults(h => h.ConfigurePrimaryHttpMessageHandler(() => cloudflare))));
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, "turn-down@x.test", "password123");

        var ws = await factory.Server.CreateWebSocketClient()
            .ConnectAsync(new Uri(factory.Server.BaseAddress, "/api/broker/ws"), CancellationToken.None);
        await ws.SendAsync(Encoding.UTF8.GetBytes($$"""{"type":"auth","token":"{{token}}"}"""),
            WebSocketMessageType.Text, true, CancellationToken.None);
        var buf = new byte[64 * 1024];
        var r = await ws.ReceiveAsync(buf, CancellationToken.None);

        Assert.Equal(WebSocketMessageType.Text, r.MessageType);
        var servers = JsonDocument.Parse(buf.AsMemory(0, r.Count)).RootElement.GetProperty("iceServers");
        Assert.Equal(1, servers.GetArrayLength());
        Assert.StartsWith("stun:", servers[0].GetProperty("urls")[0].GetString());
    }

    static async Task WaitFor(Func<bool> done)
    {
        for (var i = 0; i < 100 && !done(); i++)
        {
            await Task.Delay(50);   // revoke runs as the server's socket handler unwinds
        }
        Assert.True(done());
    }

    /// Stands in for rtc.live.cloudflare.com: mints a unique username per call.
    sealed class FakeCloudflare : HttpMessageHandler
    {
        public readonly ConcurrentBag<string> Calls = new();
        public bool TimeOut { get; init; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage rq, CancellationToken ct)
        {
            Assert.Equal("Bearer tok", rq.Headers.Authorization?.ToString());
            var path = rq.RequestUri?.AbsolutePath ?? "";
            Calls.Add(path);
            if (TimeOut)
            {
                // What HttpClient's own timeout throws: a cancellation the caller didn't ask for.
                throw new TaskCanceledException("timed out", new TimeoutException());
            }
            if (path.EndsWith("/revoke"))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
            }
            var body = $$"""
                {"iceServers":[{"urls":["stun:stun.cloudflare.com:3478"]},
                 {"urls":["turn:turn.cloudflare.com:3478?transport=udp"],"username":"{{Guid.NewGuid():N}}","credential":"c"}]}
                """;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Created) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }
}
