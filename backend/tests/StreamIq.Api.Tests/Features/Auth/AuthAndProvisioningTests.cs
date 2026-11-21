using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Auth;

[Collection("integration")]
public class AuthAndProvisioningTests(IntegrationFixture fx)
{
    [Fact]
    public async Task No_token_is_rejected_401()
    {
        await fx.ResetAsync();
        using var client = fx.Factory.CreateClient();
        var resp = await client.GetAsync("/api/members");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Garbage_token_is_rejected_401()
    {
        await fx.ResetAsync();
        using var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "not-a-jwt");
        var resp = await client.GetAsync("/api/members");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task First_sign_in_provisions_exactly_one_user_and_no_household()
    {
        await fx.ResetAsync();
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, "new@x.test", "password123");
        using var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        var resp = await client.GetAsync("/api/members");   // signs in: adds the user, who has no household
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);

        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        Assert.Equal(1, await db.Users.CountAsync());
        Assert.Equal(0, await db.Tenants.CountAsync());   // #387: a household is made on purpose, never by sign-up
        Assert.Equal(0, await db.Memberships.IgnoreQueryFilters().CountAsync());
    }

    private async Task<string> UserOf(string token)
    {
        using var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var me = await OwnHousehold.RawMeAsync(fx, client);
        return me.GetProperty("userId").GetString() ?? throw new InvalidOperationException("no userId");
    }

    [Fact]
    public async Task Google_sign_in_provisions_a_user_and_stores_no_profile_claims()
    {
        await fx.ResetAsync();
        var token = await TokenMinter.MintGoogleIdTokenAsync(fx.EmulatorHost, $"g-{Guid.NewGuid():N}", $"g-{Guid.NewGuid():N}@x.test");

        var userId = await UserOf(token);
        Assert.Equal(userId, await UserOf(token)); // returning Google user resolves, not re-provisions

        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        Assert.Equal(1, await db.Users.CountAsync());
        Assert.Equal(0, await db.Tenants.CountAsync());
        // #65/#66: name/picture claims must not land in our DB (the users row has no column for them).
    }

    [Fact]
    public async Task Google_sign_in_with_an_existing_password_email_is_the_same_user()
    {
        await fx.ResetAsync();
        var email = $"both-{Guid.NewGuid():N}@x.test";
        var passwordUser = await UserOf(await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123"));
        var googleUser = await UserOf(await TokenMinter.MintGoogleIdTokenAsync(fx.EmulatorHost, $"g-{Guid.NewGuid():N}", email));
        Assert.Equal(passwordUser, googleUser); // Firebase one-account-per-email: same UID
    }

    [Fact]
    public async Task Concurrent_first_requests_provision_one_user_not_two()
    {
        await fx.ResetAsync();
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, "race@x.test", "password123");

        async Task Hit()
        {
            using var client = fx.Factory.CreateClient();
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/members")).StatusCode); // no household yet
        }
        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => Hit()));

        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        Assert.Equal(1, await db.Users.CountAsync());
        Assert.Equal(0, await db.Tenants.CountAsync());
    }
}
