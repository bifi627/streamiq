using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Onboarding;

[Collection("integration")]
public class RateLimitTests(IntegrationFixture fx)
{
    [Fact]
    public async Task Enrollment_is_limited_per_client_ip()
    {
        using var factory = fx.Factory.WithWebHostBuilder(b => b
            .UseSetting("STREAMIQ_SIGNALING_PER_MINUTE", "2")
            .UseSetting("STREAMIQ_CLIENT_IP_HEADER", "X-Real-IP"));
        using var client = factory.CreateClient();

        async Task<HttpStatusCode> Enroll(string ip)
        {
            using var rq = new HttpRequestMessage(HttpMethod.Post, "/api/gateways/enroll") { Content = JsonContent.Create(new { }) };
            rq.Headers.Add("X-Real-IP", ip);
            return (await client.SendAsync(rq)).StatusCode;
        }

        Assert.Equal(HttpStatusCode.BadRequest, await Enroll("203.0.113.1"));
        Assert.Equal(HttpStatusCode.BadRequest, await Enroll("203.0.113.1"));
        Assert.Equal(HttpStatusCode.TooManyRequests, await Enroll("203.0.113.1"));
        Assert.Equal(HttpStatusCode.BadRequest, await Enroll("203.0.113.2"));   // other IP, own budget
    }

}
