using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Reqnroll;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Features.Broker;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Tunnels;

/// Drives the real broker sockets through BrokerSteps (same scenario instance).
[Binding]
public class TunnelTelemetrySteps(IntegrationFixture fx, BrokerSteps broker)
{
    private HttpResponseMessage? _last;

    // Raw rows: the test reads across tenants on purpose (no CurrentTenantId ⇒
    // the filter would hide everything).
    private async Task<T> Rows<T>(Func<IQueryable<Tunnel>, Task<T>> q)
    {
        using var scope = fx.Factory.Services.CreateScope();
        return await q(scope.ServiceProvider.GetRequiredService<StreamIqDbContext>().Tunnels.IgnoreQueryFilters().AsNoTracking());
    }

    private Task<Tunnel> Row()
    {
        return Rows(q => q.SingleAsync());
    }

    // The broker writes asynchronously to what the test sees (sockets): wait for it.
    private async Task<Tunnel> RowWhen(Func<Tunnel, bool> done)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (true)
        {
            var row = await Row();
            if (done(row))
            {
                return row;
            }
            Assert.True(DateTime.UtcNow < deadline, "tunnel row never got there");
            await Task.Delay(20);
        }
    }

    private async Task<JsonElement> Me(string email)
    {
        using var client = await broker.SignedIn(email);
        return await client.GetFromJsonAsync<JsonElement>("/api/me");
    }

    [Then("the tunnel is stored for gateway \"(.*)\" in the household of \"(.*)\" by \"(.*)\"")]
    public async Task ThenStoredFor(string gateway, string owner, string user)
    {
        var row = await Row();
        Assert.Equal(broker.Session, row.Id);
        Assert.Equal(broker.Gateway(gateway).Id, row.GatewayId);
        Assert.Equal((await Me(owner)).GetProperty("tenantId").GetGuid(), row.TenantId);
        Assert.Equal((await Me(user)).GetProperty("userId").GetGuid(), row.UserId);
        Assert.Null(row.BytesSent);
    }

    [Then("no tunnel is stored")]
    public async Task ThenNone()
    {
        Assert.Equal(0, await Rows(q => q.CountAsync()));
    }

    [Then("the tunnel has no end time")]
    public async Task ThenNotEnded()
    {
        Assert.Null((await Row()).EndedAt);
    }

    [When("the browser closes its socket")]
    public Task WhenBrowserCloses()
    {
        return broker.Browser.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
    }

    [StepDefinition("the tunnel gets an end time")]
    public async Task ThenEnded()
    {
        var row = await RowWhen(r => r.EndedAt is not null);
        Assert.True(row.EndedAt >= row.CreatedAt);
    }

    [When("gateway \"(.*)\" reports that tunnel as relayed with ([0-9]+) bytes sent")]
    public Task WhenReportsRelayed(string gateway, long bytes)
    {
        return BrokerSteps.Send(broker.Gateway(gateway).Ws, new
        {
            type = "tunnel",
            session = broker.Session,
            relay = true,
            ipv6 = false,
            localCandidateType = "host",
            remoteCandidateType = "relay",
            protocol = "udp",
            bytesSent = bytes,
            bytesReceived = 10,
            failure = (string?)null,
        });
    }

    [When("gateway \"(.*)\" reports that tunnel as failed because \"(.*)\"")]
    public Task WhenReportsFailed(string gateway, string reason)
    {
        return BrokerSteps.Send(broker.Gateway(gateway).Ws, new
        {
            type = "tunnel",
            session = broker.Session,
            relay = false,
            ipv6 = false,
            bytesSent = 1,
            bytesReceived = 1,
            failure = reason,
        });
    }

    [Then("the tunnel is stored as relayed with ([0-9]+) bytes sent and no failure")]
    public async Task ThenReported(long bytes)
    {
        var row = await RowWhen(r => r.BytesSent is not null);
        // A later report (if any) had its chance: the gateway socket handles messages in order.
        await Task.Delay(300);
        row = await Row();
        Assert.True(row.Relay);
        Assert.Equal(bytes, row.BytesSent);
        Assert.Equal(10, row.BytesReceived);
        Assert.Equal("relay", row.RemoteCandidateType);
        Assert.Null(row.Failure);
    }

    [Then("the tunnel has no report")]
    public async Task ThenNoReport()
    {
        // No ack on the socket: give the broker time to (not) apply it.
        await Task.Delay(1000);
        var row = await Row();
        Assert.Null(row.BytesSent);
        Assert.False(row.Relay);
    }

    [When("\"([^\"]*)\" reports ([0-9]+) kbps for that tunnel")]
    public async Task WhenThroughput(string email, int kbps)
    {
        using var client = await broker.SignedIn(email);
        _last = await client.PatchAsJsonAsync($"/api/tunnels/{broker.Session}", new { throughputKbps = kbps });
    }

    // A member of the tunnel's household still can't touch another user's tunnel.
    [When("\"([^\"]*)\" reports ([0-9]+) kbps for that tunnel naming the household of \"([^\"]*)\"")]
    public async Task WhenThroughputNaming(string email, int kbps, string owner)
    {
        var household = (await Me(owner)).GetProperty("tenantId").GetString();
        using var client = await broker.SignedIn(email);
        client.DefaultRequestHeaders.Add(StreamIq.Api.Auth.Households.Header, household);
        _last = await client.PatchAsJsonAsync($"/api/tunnels/{broker.Session}", new { throughputKbps = kbps });
    }

    [Then("the throughput is accepted")]
    public void ThenAccepted()
    {
        Assert.Equal(HttpStatusCode.NoContent, _last?.StatusCode);
    }

    [Then("the request is refused with 404")]
    public void ThenNotFound()
    {
        Assert.Equal(HttpStatusCode.NotFound, _last?.StatusCode);
    }

    [Then("the tunnel has ([0-9]+) kbps")]
    public async Task ThenKbps(int kbps)
    {
        Assert.Equal(kbps, (await Row()).ThroughputKbps);
    }

    // The account-deletion path's DB half (CLAUDE.md: DELETE the users row).
    [When("the users row of \"(.*)\" is deleted")]
    public async Task WhenUserDeleted(string email)
    {
        var id = (await Me(email)).GetProperty("userId").GetGuid();
        using var scope = fx.Factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<StreamIqDbContext>().Users.Where(u => u.Id == id).ExecuteDeleteAsync();
    }

    [Then("the tunnel is kept without a user")]
    public async Task ThenKeptWithoutUser()
    {
        var row = await Row();
        Assert.Equal(broker.Session, row.Id);
        Assert.Null(row.UserId);
    }

    [Then("the tunnel has no throughput")]
    public async Task ThenNoKbps()
    {
        Assert.Null((await Row()).ThroughputKbps);
    }
}
