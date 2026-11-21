using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Reqnroll;
using StreamIq.Api.Data;
using StreamIq.Api.Features.Broker;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Broker;

/// Drives the real gateway socket through BrokerSteps (same scenario instance).
[Binding]
public class GatewayHealthSteps(IntegrationFixture fx, BrokerSteps broker)
{
    private Guid _foreign;

    // Raw rows: the test reads across tenants on purpose.
    private async Task<T> Db<T>(Func<StreamIqDbContext, Task<T>> q)
    {
        using var scope = fx.Factory.Services.CreateScope();
        return await q(scope.ServiceProvider.GetRequiredService<StreamIqDbContext>());
    }

    private Task<Gateway> GatewayRow(string name)
    {
        var id = broker.Gateway(name).Id;
        return Db(db => db.Gateways.IgnoreQueryFilters().AsNoTracking().SingleAsync(g => g.Id == id));
    }

    private IQueryable<GatewayHealth> Rows(StreamIqDbContext db, string name)
    {
        var id = broker.Gateway(name).Id;
        return db.GatewayHealth.IgnoreQueryFilters().AsNoTracking().Where(r => r.GatewayId == id);
    }

    private static object Health(string jellyfin, int tunnels)
    {
        return new
        {
            jellyfin = new { reachable = true, version = jellyfin },
            os = "linux",
            arch = "amd64",
            transcoding = "none",
            offline = "enforced",
            tunnels,
            transcodes = 0,
            cpu = 12.5,
            memory = 47.3,
        };
    }

    // The socket answers nothing: poll until it's there.
    private static async Task Eventually(Func<Task<bool>> done, string what)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!await done())
        {
            Assert.True(DateTime.UtcNow < deadline, what);
            await Task.Delay(20);
        }
    }

    [When("gateway \"([^\"]*)\" sends a full heartbeat with Jellyfin \"([^\"]*)\" and ([0-9]+) tunnels")]
    public Task WhenFull(string name, string jellyfin, int tunnels)
    {
        return BrokerSteps.Send(broker.Gateway(name).Ws,
            new { type = "heartbeat", protocol = GatewaySocket.MinGatewayProtocol, telemetry = "full", health = Health(jellyfin, tunnels) });
    }

    // With health anyway: a level other than full stores none of it.
    [When("gateway \"([^\"]*)\" sends a heartbeat at level \"([^\"]*)\" with Jellyfin \"([^\"]*)\"")]
    public Task WhenLevel(string name, string level, string jellyfin)
    {
        return BrokerSteps.Send(broker.Gateway(name).Ws,
            new { type = "heartbeat", protocol = GatewaySocket.MinGatewayProtocol, telemetry = level, health = Health(jellyfin, 1) });
    }

    [Then("gateway \"([^\"]*)\" has telemetry \"([^\"]*)\"")]
    public Task ThenLevel(string name, string level)
    {
        return Eventually(async () => (await GatewayRow(name)).Telemetry == level, $"telemetry never became {level}");
    }

    [Then("gateway \"([^\"]*)\" has no telemetry level")]
    public async Task ThenNoLevel(string name)
    {
        await Eventually(async () => (await GatewayRow(name)).LastSeenAt is not null, "no heartbeat stored");
        Assert.Null((await GatewayRow(name)).Telemetry);
    }

    [Then("gateway \"([^\"]*)\" has ([0-9]+) health rows")]
    public async Task ThenRows(string name, int n)
    {
        await Eventually(async () => await Db(db => Rows(db, name).CountAsync()) >= n, $"fewer than {n} rows");
        await Task.Delay(300);   // the socket handles messages in order: a stray insert would be in by now
        Assert.Equal(n, await Db(db => Rows(db, name).CountAsync()));
    }

    [Then("the latest health row of gateway \"([^\"]*)\" has Jellyfin \"([^\"]*)\" and ([0-9]+) tunnels")]
    public async Task ThenLatest(string name, string jellyfin, int tunnels)
    {
        var row = await Db(db => Rows(db, name).OrderByDescending(r => r.At).FirstAsync());
        Assert.Equal((await GatewayRow(name)).TenantId, row.TenantId);
        Assert.Equal(("full", true, jellyfin, "linux", "amd64", "none", "enforced"),
            (row.Level, row.JellyfinReachable, row.JellyfinVersion, row.Os, row.Arch, row.Transcoding, row.Offline));
        Assert.Equal((tunnels, 0, 12.5, 47.3), (row.Tunnels, row.Transcodes, row.Cpu, row.Memory));
    }

    [When("the latest health row of gateway \"([^\"]*)\" is 5 minutes old")]
    public Task WhenOld(string name)
    {
        return Db(db => Rows(db, name).ExecuteUpdateAsync(s => s.SetProperty(r => r.At, r => r.At - HealthReport.SnapshotEvery)));
    }

    [Given("the household of \"([^\"]*)\" has a health row for gateway \"([^\"]*)\" with Jellyfin \"([^\"]*)\"")]
    public async Task GivenForeignRow(string email, string name, string jellyfin)
    {
        using var client = await broker.SignedIn(email);
        _foreign = (await client.GetFromJsonAsync<JsonElement>("/api/me")).GetProperty("tenantId").GetGuid();
        await Db(db =>
        {
            db.GatewayHealth.Add(new GatewayHealth
            {
                TenantId = _foreign,
                GatewayId = broker.Gateway(name).Id,
                At = DateTimeOffset.UtcNow,
                Level = HealthReport.Full,
                JellyfinReachable = true,
                JellyfinVersion = jellyfin,
                Os = "linux",
                Arch = "amd64",
                Transcoding = "none",
                Offline = "enforced",
            });
            return db.SaveChangesAsync();
        });
    }

    [Then("the household of \"([^\"]*)\" still has its health row")]
    public async Task ThenForeignKept(string email)
    {
        Assert.Equal(1, await Db(db => db.GatewayHealth.IgnoreQueryFilters().CountAsync(r => r.TenantId == _foreign)));
    }

    [Then("\"([^\"]*)\" sees gateway \"([^\"]*)\" with telemetry \"([^\"]*)\"")]
    public async Task ThenListed(string email, string name, string level)
    {
        Assert.Equal(level, await Listed(email, name));
    }

    [Then("\"([^\"]*)\" sees gateway \"([^\"]*)\" with no telemetry level")]
    public async Task ThenListedNone(string email, string name)
    {
        Assert.Null(await Listed(email, name));
    }

    private async Task<string?> Listed(string email, string name)
    {
        using var client = await broker.SignedIn(email);
        var id = broker.Gateway(name).Id;
        // Acting in the gateway's household: a member also has a household of their own.
        client.DefaultRequestHeaders.Add(StreamIq.Api.Auth.Households.Header, (await GatewayRow(name)).TenantId.ToString());
        var list = await client.GetFromJsonAsync<JsonElement>("/api/gateways");
        return list.EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == id).GetProperty("telemetry").GetString();
    }
}
