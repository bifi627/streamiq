using System.Net.Http.Headers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Reqnroll;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Auth;

[Binding]
public class ProvisioningSteps(IntegrationFixture fx)
{
    [When("a new user \"(.*)\" signs in")]
    public async Task WhenSignsIn(string email)
    {
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123");
        using var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        (await client.GetAsync("/api/me")).EnsureSuccessStatusCode();
    }

    [Then("there is exactly (.*) tenant and (.*) user")]
    public async Task ThenCounts(int tenants, int users)
    {
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        Assert.Equal(tenants, await db.Tenants.CountAsync());
        Assert.Equal(users, await db.Users.CountAsync());
    }
}
