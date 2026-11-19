using System.Text.Json.Nodes;
using StreamIq.Api.Features.Broker;
using static StreamIq.Api.Features.Broker.BrowserSocket;
using static StreamIq.Api.Features.Broker.GatewaySocket;

namespace StreamIq.Api.Tests.Features.Broker;

// Untrusted socket messages parse into records without a database (#540). A field of
// the wrong JSON type reads as missing, never a throw that drops the socket. Whole
// records are compared, so two swapped same-typed fields fail.
public class SocketMessageTests
{
    static JsonObject Msg(string json)
    {
        return JsonNode.Parse(json)?.AsObject() ?? throw new ArgumentException(json);
    }

    static readonly Guid Session = Guid.Parse("6f9619ff-8b86-d011-b42d-00cf4fc964ff");

    [Fact]
    public void HeartbeatParsesEveryField()
    {
        var m = Msg("""{"type":"heartbeat","protocol":2,"lanUrl":"http://nas.local:8096","version":"1.4.0","update":"1.6.0","name":" nas "}""");
        Assert.Equal(new Heartbeat(2, "http://nas.local:8096/", "1.4.0", "1.6.0", "nas"), Heartbeat.Parse(m));
    }

    [Fact]
    public void HeartbeatFieldsOfTheWrongTypeReadAsMissing()
    {
        var m = Msg("""{"type":"heartbeat","protocol":1,"lanUrl":5,"version":true,"update":[],"name":5}""");
        Assert.Equal(new Heartbeat(1, null, null, null, null), Heartbeat.Parse(m));
    }

    // An old gateway's other fields can't skip the "update required" write: its
    // protocol reads as 0 whatever else it sent.
    [Theory]
    [InlineData("""{"type":"heartbeat","name":5,"lanUrl":{}}""")]
    [InlineData("""{"type":"heartbeat","protocol":"1","name":5}""")]
    [InlineData("""{"type":"heartbeat","protocol":1.5}""")]
    [InlineData("""{"type":"heartbeat","protocol":null}""")]
    public void HeartbeatProtocolMissingOrNotAnIntIsZero(string json)
    {
        Assert.Equal(0, Heartbeat.ProtocolOf(Msg(json)));
        Assert.Equal(0, Heartbeat.Parse(Msg(json)).Protocol);
    }

    [Theory]
    [InlineData("""{"version":""}""", "", null)]
    [InlineData("""{"update":""}""", null, null)]
    [InlineData("""{"version":"12345678901234567890123456789012345678901"}""", null, null)]
    [InlineData("""{"update":"1234567890123456789012345678901234567890"}""", null, "1234567890123456789012345678901234567890")]
    public void HeartbeatVersionAndUpdateLimits(string json, string? version, string? update)
    {
        var h = Heartbeat.Parse(Msg(json));
        Assert.Equal((version, update), (h.Version, h.Update));
    }

    [Fact]
    public void TunnelReportParsesEveryField()
    {
        var m = Msg($$"""
            {"type":"tunnel","session":"{{Session}}","bytesSent":10,"bytesReceived":20,"relay":true,"ipv6":true,
             "localCandidateType":"host","remoteCandidateType":"srflx","protocol":"udp","failure":"ice failed"}
            """);
        Assert.Equal(new TunnelReport(Session, 10, 20, true, true, "host", "srflx", "udp", "ice failed"), TunnelReport.Parse(m));
    }

    [Fact]
    public void TunnelReportOptionalFieldsOfTheWrongTypeReadAsMissing()
    {
        var m = Msg($$"""
            {"session":"{{Session}}","bytesSent":0,"bytesReceived":0,"relay":"yes","ipv6":1,
             "localCandidateType":5,"remoteCandidateType":[],"protocol":{},"failure":false}
            """);
        Assert.Equal(new TunnelReport(Session, 0, 0, false, false, null, null, null, null), TunnelReport.Parse(m));
    }

    [Theory]
    [InlineData("""{"bytesSent":1,"bytesReceived":1}""")]                                  // no session
    [InlineData("""{"session":"nope","bytesSent":1,"bytesReceived":1}""")]                 // not a Guid
    [InlineData("""{"session":5,"bytesSent":1,"bytesReceived":1}""")]                      // wrong type
    [InlineData("""{"session":"{S}","bytesReceived":1}""")]                                // no bytesSent
    [InlineData("""{"session":"{S}","bytesSent":"1","bytesReceived":1}""")]                // wrong type
    [InlineData("""{"session":"{S}","bytesSent":-1,"bytesReceived":1}""")]                 // negative
    [InlineData("""{"session":"{S}","bytesSent":1,"bytesReceived":-1}""")]
    [InlineData("""{"session":"{S}","bytesSent":1.5,"bytesReceived":1}""")]                // not an integer
    public void TunnelReportWithoutSessionOrByteCountsIsNull(string json)
    {
        Assert.Null(TunnelReport.Parse(Msg(json.Replace("{S}", Session.ToString()))));
    }

    [Theory]
    [InlineData("""{"type":"auth","token":"t"}""", "t")]
    [InlineData("""{"type":"auth","token":5}""", null)]
    [InlineData("""{"type":"auth"}""", null)]
    public void AuthParsesTheToken(string json, string? token)
    {
        Assert.Equal(new BrowserSocket.Auth(token), BrowserSocket.Auth.Parse(Msg(json)));
    }

    [Theory]
    [InlineData("""{"type":"offer","token":"t"}""")]
    [InlineData("""{"type":5,"token":"t"}""")]
    [InlineData("""{"token":"t"}""")]
    public void AnythingButAuthFirstIsNotAuth(string json)
    {
        Assert.Null(BrowserSocket.Auth.Parse(Msg(json)));
    }

    [Fact]
    public void OfferParsesTheGatewayAndKeepsTheSdp()
    {
        var m = Msg($$"""{"type":"offer","gatewayId":"{{Session}}","sdp":"v=0"}""");
        Assert.Equal(new Offer(Session, m["sdp"]), Offer.Parse(m));
    }

    // Reads as missing: the browser is told "gateway offline or unknown".
    [Theory]
    [InlineData("""{"type":"offer","gatewayId":5}""")]
    [InlineData("""{"type":"offer","gatewayId":"nope"}""")]
    [InlineData("""{"type":"offer"}""")]
    public void OfferWithoutAGatewayIdHasNone(string json)
    {
        Assert.Null(Offer.Parse(Msg(json)).GatewayId);
    }

    [Fact]
    public void IceKeepsTheCandidate()
    {
        var m = Msg("""{"type":"ice","candidate":{"candidate":"c"}}""");
        Assert.Equal(new Ice(m["candidate"]), Ice.Parse(m));
    }

    [Fact]
    public void TheMessageTypeOfTheWrongTypeIsMissing()
    {
        Assert.Null(StreamIq.Api.Features.Broker.Broker.Str(Msg("""{"type":5}"""), "type"));
    }
}
