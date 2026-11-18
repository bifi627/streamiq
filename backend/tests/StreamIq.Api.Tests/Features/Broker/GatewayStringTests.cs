using System.Reflection;
using StreamIq.Api.Features.Broker;

namespace StreamIq.Api.Tests.Features.Broker;

// Gateway-supplied strings never reach Postgres or the web app in a form they refuse
// (#310 name, #390 tunnel report, lanUrl link). Clip and SafeLanUrl are private:
// called by name so the production code stays as it is (#529).
public class GatewayStringTests
{
    static string? Call(string method, params object?[] args)
    {
        var m = typeof(GatewaySocket).GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new MissingMethodException(nameof(GatewaySocket), method);
        return (string?)m.Invoke(null, args);
    }

    static string? Clip(string? s, int max = 16)
    {
        return Call("Clip", s, max);
    }

    static string? SafeLanUrl(string? s)
    {
        return Call("SafeLanUrl", s);
    }

    [Theory]
    [InlineData("  Living room  ", "Living room")]
    [InlineData("", null)]
    [InlineData("   ", null)]
    [InlineData(null, null)]
    [InlineData("a\0b", null)]
    [InlineData("a\nb", null)]
    public void SafeNameCleans(string? sent, string? stored)
    {
        Assert.Equal(stored, GatewaySocket.SafeName(sent));
    }

    [Fact]
    public void SafeNameCutsTo100WithoutSplittingASurrogatePair()
    {
        Assert.Equal(new string('x', 100), GatewaySocket.SafeName(new string('x', 120)));
        Assert.Equal(new string('x', 99), GatewaySocket.SafeName(new string('x', 99) + "😀😀"));
    }

    // Exactly 100 is kept whole. Ending in a high surrogate makes a cut at 100 visible.
    [Fact]
    public void SafeNameKeepsExactly100()
    {
        var n = new string('x', 99) + "\uD83D";
        Assert.Equal(n, GatewaySocket.SafeName(n));
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("udp", "udp")]
    [InlineData("u\u0001p", null)]   // a control character anywhere, not only when all are
    [InlineData("\0", null)]
    public void ClipCleans(string? sent, string? stored)
    {
        Assert.Equal(stored, Clip(sent));
    }

    [Fact]
    public void ClipCutsAtItsLimitWithoutSplittingASurrogatePair()
    {
        var exact = new string('x', 15) + "\uD83D";   // 16: kept whole (a cut would drop the last char)
        Assert.Equal(exact, Clip(exact));
        Assert.Equal(new string('x', 16), Clip(new string('x', 17)));
        Assert.Equal(new string('x', 15), Clip(new string('x', 15) + "😀"));
        Assert.Equal(new string('x', 64), Clip(new string('x', 70), 64));
    }

    [Theory]
    [InlineData("http://192.168.1.20:8096", "http://192.168.1.20:8096/")]
    [InlineData("https://nas.local/", "https://nas.local/")]
    [InlineData("javascript:alert(1)", null)]
    [InlineData("ftp://nas.local/", null)]
    [InlineData("not a url", null)]
    [InlineData(null, null)]
    public void SafeLanUrlAllowsOnlyHttp(string? sent, string? stored)
    {
        Assert.Equal(stored, SafeLanUrl(sent));
    }

    [Fact]
    public void SafeLanUrlKeepsExactly200()
    {
        var url = "http://h/" + new string('a', 191);
        Assert.Equal(200, url.Length);
        Assert.Equal(url, SafeLanUrl(url));
        Assert.Null(SafeLanUrl(url + "a"));
    }
}
