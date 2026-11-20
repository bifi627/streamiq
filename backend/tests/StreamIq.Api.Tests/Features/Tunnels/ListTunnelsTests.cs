using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;
using StreamIq.Api.Features.Tunnels;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Tunnels;

[Collection("integration")]
public class ListTunnelsTests(IntegrationFixture fx)
{
    private async Task<HttpClient> SignedInClient(string email)
    {
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123");
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    private async Task Seed(Action<StreamIqDbContext> add)
    {
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        add(db);
        await db.SaveChangesAsync();
    }

    private static Tunnel Row(Guid tenant, Guid gateway, Guid user, TimeSpan age)
    {
        return new Tunnel { Id = Guid.NewGuid(), TenantId = tenant, GatewayId = gateway, UserId = user, CreatedAt = DateTimeOffset.UtcNow - age };
    }

    [Fact]
    public async Task Only_the_callers_own_tunnels_in_the_requests_household_from_the_last_30_days()
    {
        await fx.ResetAsync();
        using var alice = await SignedInClient("alice@x.test");
        var aliceMe = await OwnHousehold.MeAsync(alice);
        var (home, aliceId) = (aliceMe.GetProperty("tenantId").GetGuid(), aliceMe.GetProperty("userId").GetGuid());
        using var bob = await SignedInClient("bob@x.test");
        var bobMe = await OwnHousehold.MeAsync(bob);
        var (away, bobId) = (bobMe.GetProperty("tenantId").GetGuid(), bobMe.GetProperty("userId").GetGuid());

        // Bob is also a member of Alice's household; Alice of Bob's.
        var nas = new Gateway { Id = Guid.NewGuid(), TenantId = home, Name = "nas", CredentialHash = null };   // revoked: keeps its name
        var other = new Gateway { Id = Guid.NewGuid(), TenantId = away, Name = "other", CredentialHash = "seeded" };
        var mine = Row(home, nas.Id, aliceId, TimeSpan.FromHours(1));
        mine.Relay = true;
        mine.Ipv6 = true;
        mine.BytesSent = 5000;
        mine.BytesReceived = 10;
        mine.ThroughputKbps = 20000;
        mine.Failure = "x";
        mine.Use = "playback";
        mine.ActiveMs = 4200;
        mine.EndedAt = mine.CreatedAt.AddMinutes(5);
        await Seed(db =>
        {
            db.Memberships.Add(new Membership { TenantId = home, UserId = bobId, Role = Membership.Member });
            db.Memberships.Add(new Membership { TenantId = away, UserId = aliceId, Role = Membership.Member });
            db.Gateways.AddRange(nas, other);
            db.Tunnels.AddRange(
                mine,
                Row(home, nas.Id, aliceId, TimeSpan.FromDays(31)),   // too old
                Row(home, nas.Id, bobId, TimeSpan.FromHours(2)),     // another member's
                Row(away, other.Id, aliceId, TimeSpan.FromHours(3)));  // her own, another household
        });

        alice.DefaultRequestHeaders.Add(Households.Header, home.ToString());
        var rows = await alice.GetFromJsonAsync<JsonElement>("/api/tunnels");

        var row = Assert.Single(rows.EnumerateArray());
        Assert.Equal(mine.Id, row.GetProperty("id").GetGuid());
        Assert.Equal(nas.Id, row.GetProperty("gatewayId").GetGuid());
        Assert.Equal("nas", row.GetProperty("gatewayName").GetString());
        Assert.True(row.GetProperty("relay").GetBoolean());
        Assert.True(row.GetProperty("ipv6").GetBoolean());
        Assert.Equal(5000, row.GetProperty("bytesSent").GetInt64());
        Assert.Equal(10, row.GetProperty("bytesReceived").GetInt64());
        Assert.Equal(20000, row.GetProperty("throughputKbps").GetInt32());
        Assert.Equal("x", row.GetProperty("failure").GetString());
        Assert.Equal("playback", row.GetProperty("use").GetString());
        Assert.Equal(4200, row.GetProperty("activeMs").GetInt64());
        Assert.Equal(JsonValueKind.String, row.GetProperty("endedAt").ValueKind);
        Assert.False(row.TryGetProperty("localCandidateType", out _));
        Assert.False(row.TryGetProperty("userId", out _));
    }

    [Fact]
    public async Task At_most_200_newest_first()
    {
        await fx.ResetAsync();
        using var alice = await SignedInClient("alice@x.test");
        var me = await OwnHousehold.MeAsync(alice);
        var (home, aliceId) = (me.GetProperty("tenantId").GetGuid(), me.GetProperty("userId").GetGuid());
        var nas = new Gateway { Id = Guid.NewGuid(), TenantId = home, Name = "nas", CredentialHash = "seeded" };
        await Seed(db =>
        {
            db.Gateways.Add(nas);
            db.Tunnels.AddRange(Enumerable.Range(1, ListTunnels.Limit + 5).Select(i => Row(home, nas.Id, aliceId, TimeSpan.FromMinutes(i))));
        });

        var rows = (await alice.GetFromJsonAsync<JsonElement>("/api/tunnels")).EnumerateArray()
            .Select(r => r.GetProperty("createdAt").GetDateTimeOffset()).ToList();

        Assert.Equal(ListTunnels.Limit, rows.Count);
        Assert.Equal(rows.OrderByDescending(t => t), rows);
        Assert.True(DateTimeOffset.UtcNow - rows[^1] < TimeSpan.FromMinutes(ListTunnels.Limit + 1));   // the 5 oldest are the cut ones
    }
}
