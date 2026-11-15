using StreamIq.Api.Features.Broker;

namespace StreamIq.Api.Tests.Features.Broker;

// #310: the heartbeat's name never reaches Postgres in a form it refuses.
public class SafeNameTests
{
    [Theory]
    [InlineData("  Living room  ", "Living room")]
    [InlineData("", null)]
    [InlineData("   ", null)]
    [InlineData(null, null)]
    [InlineData("a\0b", null)]
    [InlineData("a\nb", null)]
    public void Cleans(string? sent, string? stored)
    {
        Assert.Equal(stored, GatewaySocket.SafeName(sent));
    }

    [Fact]
    public void CutsTo100WithoutSplittingASurrogatePair()
    {
        Assert.Equal(new string('x', 100), GatewaySocket.SafeName(new string('x', 120)));
        var cut = GatewaySocket.SafeName(new string('x', 99) + "😀😀");
        Assert.Equal(new string('x', 99), cut);
    }
}
