using System.Text.Json.Nodes;
using StreamIq.Api.Features.Gateways;

namespace StreamIq.Api.Tests.Features.Gateways;

// The heartbeat status is untrusted gateway input: only known, bounded fields survive.
public class GatewayStatusTests
{
    static string? Sanitize(string heartbeat)
    {
        return GatewayStatus.From(JsonNode.Parse(heartbeat)?.AsObject() ?? throw new ArgumentException(heartbeat));
    }

    [Fact]
    public void No_status_fields_means_null()
    {
        Assert.Null(Sanitize("""{ "type": "heartbeat", "version": "1.4.0" }"""));
    }

    [Fact]
    public void Wrong_types_out_of_range_and_unknown_values_are_dropped()
    {
        var tooLong = new string('x', 41);
        Assert.Equal("""{"os":"windows","activeSessions":3,"jellyfin":{"version":"10.11.2"}}""", Sanitize($$"""
            {
              "os": "windows", "arch": 64, "update": "{{tooLong}}",
              "startedAt": "not a date", "pairedClients": -1, "activeSessions": 3,
              "jellyfin": { "reachable": "yes", "version": "10.11.2", "token": "admin", "secret": "k" },
              "clientNames": ["Jo's iPhone"]
            }
            """));
    }

    [Fact]
    public void A_full_snapshot_round_trips_with_startedAt_in_utc()
    {
        Assert.Equal(
            """{"os":"linux","arch":"arm64","update":"1.6.0","startedAt":"2026-11-10T07:00:00+00:00","pairedClients":2,"activeSessions":0,"jellyfin":{"reachable":true,"version":"10.11.2","untested":false,"token":"legacy"}}""",
            Sanitize("""
                {
                  "os": "linux", "arch": "arm64", "update": "1.6.0", "startedAt": "2026-11-10T08:00:00+01:00",
                  "pairedClients": 2, "activeSessions": 0,
                  "jellyfin": { "reachable": true, "version": "10.11.2", "untested": false, "token": "legacy" }
                }
                """));
    }
}
