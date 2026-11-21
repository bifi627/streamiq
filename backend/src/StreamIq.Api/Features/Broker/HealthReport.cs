using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using StreamIq.Api.Data;

namespace StreamIq.Api.Features.Broker;

/// A `full` heartbeat's `health` (docs/protocol.md), each field cleaned at the boundary:
/// out of bounds or of the wrong type = null.
internal sealed record HealthReport(bool? JellyfinReachable, string? JellyfinVersion, string? Os, string? Arch,
    string? Transcoding, string? Offline, int? Tunnels, int? Transcodes, double? Cpu, double? Memory)
{
    public const string Off = "off", Full = "full";

    /// A row at least this often while nothing changes, so the latest row says the box was alive then.
    internal static readonly TimeSpan SnapshotEvery = TimeSpan.FromMinutes(5);

    /// Never two rows closer than this, whatever changed: the heartbeat comes every 30 s, so a
    /// gateway can't add rows faster than its schedule (a change waits for the next beat).
    internal static readonly TimeSpan MinGap = TimeSpan.FromSeconds(25);

    /// Missing = null (a gateway too old to send it); anything but `full` = `off`.
    internal static string? LevelOf(JsonObject m)
    {
        return m["telemetry"] is null ? null : Broker.Str(m, "telemetry") == Full ? Full : Off;
    }

    internal static HealthReport Parse(JsonObject m)
    {
        var h = m["health"] as JsonObject ?? [];
        var jf = h["jellyfin"] as JsonObject ?? [];
        return new(
            Broker.Value<bool>(jf, "reachable"),
            Bounded(Broker.Str(jf, "version"), 40),
            Bounded(Broker.Str(h, "os"), 20),
            Bounded(Broker.Str(h, "arch"), 20),
            Bounded(Broker.Str(h, "transcoding"), 20),
            Bounded(Broker.Str(h, "offline"), 20),
            Count(h, "tunnels"),
            Count(h, "transcodes"),
            Percent(h, "cpu"),
            Percent(h, "memory"));
    }

    /// A row when the slow-moving fields differ from the gateway's latest row, or that row is
    /// SnapshotEvery old, never within MinGap of it. Live counts and load alone don't make one (they'd add a row each beat).
    /// The tenant filter is live on the gateway socket: only this household's rows are read.
    internal async Task StoreAsync(StreamIqDbContext db, Guid tenantId, Guid gatewayId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var last = await db.GatewayHealth.AsNoTracking().Where(r => r.GatewayId == gatewayId)
            .OrderByDescending(r => r.At).FirstOrDefaultAsync(ct);
        if (last is not null && (now - last.At < MinGap || now - last.At < SnapshotEvery
            && (last.JellyfinReachable, last.JellyfinVersion, last.Os, last.Arch, last.Transcoding, last.Offline)
               == (JellyfinReachable, JellyfinVersion, Os, Arch, Transcoding, Offline)))
        {
            return;
        }
        db.GatewayHealth.Add(new GatewayHealth
        {
            TenantId = tenantId,
            GatewayId = gatewayId,
            At = now,
            Level = Full,
            JellyfinReachable = JellyfinReachable,
            JellyfinVersion = JellyfinVersion,
            Os = Os,
            Arch = Arch,
            Transcoding = Transcoding,
            Offline = Offline,
            Tunnels = Tunnels,
            Transcodes = Transcodes,
            Cpu = Cpu,
            Memory = Memory,
        });
        await db.SaveChangesAsync(ct);
        db.ChangeTracker.Clear();   // the socket's context lives for hours: don't pile up rows
    }

    // Too long or with a control character (Postgres refuses NUL) = null, never cut.
    static string? Bounded(string? s, int max)
    {
        return s is { Length: > 0 } && s.Length <= max && !s.Any(char.IsControl) ? s : null;
    }

    // ponytail: 10 000 is far above any household's tunnels or transcodes.
    static int? Count(JsonObject h, string key)
    {
        return Broker.Value<int>(h, key) is >= 0 and <= 10_000 and var n ? n : null;
    }

    static double? Percent(JsonObject h, string key)
    {
        return Broker.Value<double>(h, key) is >= 0 and <= 100 and var p ? p : null;
    }
}
