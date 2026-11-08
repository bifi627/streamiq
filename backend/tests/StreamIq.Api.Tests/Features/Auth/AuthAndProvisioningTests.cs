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
        var resp = await client.GetAsync("/me");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Garbage_token_is_rejected_401()
    {
        await fx.ResetAsync();
        using var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "not-a-jwt");
        var resp = await client.GetAsync("/me");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task First_sign_in_provisions_exactly_one_tenant_and_user()
    {
        await fx.ResetAsync();
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, "new@x.test", "password123");
        using var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        var resp = await client.GetAsync("/me");         // triggers provisioning
        resp.EnsureSuccessStatusCode();

        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        Assert.Equal(1, await db.Users.CountAsync());
        Assert.Equal(1, await db.Tenants.CountAsync());
    }

    private async Task<string> TenantOf(string token)
    {
        using var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var me = await client.GetFromJsonAsync<JsonElement>("/me");
        return me.GetProperty("tenantId").GetString() ?? throw new InvalidOperationException("/me without tenantId");
    }

    [Fact]
    public async Task Google_sign_in_provisions_a_tenant_and_stores_no_profile_claims()
    {
        await fx.ResetAsync();
        var token = await TokenMinter.MintGoogleIdTokenAsync(fx.EmulatorHost, $"g-{Guid.NewGuid():N}", $"g-{Guid.NewGuid():N}@x.test");

        var tenant = await TenantOf(token);
        Assert.Equal(tenant, await TenantOf(token)); // returning Google user resolves, not re-provisions

        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        Assert.Equal(1, await db.Users.CountAsync());
        Assert.Equal(1, await db.Tenants.CountAsync());
        // #65/#66: name/picture claims must not land in our DB.
        Assert.Null(await db.Tenants.Select(t => t.Name).SingleAsync());
    }

    [Fact]
    public async Task Google_sign_in_with_an_existing_password_email_lands_in_the_same_tenant()
    {
        await fx.ResetAsync();
        var email = $"both-{Guid.NewGuid():N}@x.test";
        var passwordTenant = await TenantOf(await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123"));
        var googleTenant = await TenantOf(await TokenMinter.MintGoogleIdTokenAsync(fx.EmulatorHost, $"g-{Guid.NewGuid():N}", email));
        Assert.Equal(passwordTenant, googleTenant); // Firebase one-account-per-email: same UID
    }

    [Fact]
    public async Task Concurrent_first_requests_provision_one_tenant_not_two()
    {
        await fx.ResetAsync();
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, "race@x.test", "password123");

        async Task Hit()
        {
            using var client = fx.Factory.CreateClient();
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            (await client.GetAsync("/me")).EnsureSuccessStatusCode();
        }
        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => Hit()));

        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        Assert.Equal(1, await db.Users.CountAsync());
        Assert.Equal(1, await db.Tenants.CountAsync());
    }
}
