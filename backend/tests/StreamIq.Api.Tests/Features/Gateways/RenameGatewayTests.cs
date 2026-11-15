using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Gateways;

[Collection("integration")]
public class RenameGatewayTests(IntegrationFixture fx)
{
    private async Task<HttpClient> SignedIn(string email, Guid? household = null)
    {
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123"));
        if (household is { } h)
        {
            client.DefaultRequestHeaders.Add(Households.Header, h.ToString());
        }
        return client;
    }

    private static async Task<JsonElement> Me(HttpClient c)
    {
        return await c.GetFromJsonAsync<JsonElement>("/api/me");
    }

    private async Task<(HttpClient Alice, Guid Tenant, Guid Gateway)> AliceWithGateway()
    {
        await fx.ResetAsync();
        var alice = await SignedIn("alice@home.test");
        var tenant = (await Me(alice)).GetProperty("tenantId").GetGuid();
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        var gw = new Gateway { TenantId = tenant, Name = "gateway", CredentialHash = "seeded" };
        db.Gateways.Add(gw);
        await db.SaveChangesAsync();
        return (alice, tenant, gw.Id);
    }

    private async Task<string?> NameOf(Guid id)
    {
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        return await db.Gateways.IgnoreQueryFilters().Where(g => g.Id == id).Select(g => g.Name).SingleAsync();
    }

    [Fact]
    public async Task An_admin_renames_a_gateway_trimmed()
    {
        var (alice, _, id) = await AliceWithGateway();
        using var _ = alice;
        var res = await alice.PatchAsJsonAsync($"/api/gateways/{id}", new { name = "  Living room NAS  " });
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
        Assert.Equal("Living room NAS", await NameOf(id));
        var list = await alice.GetFromJsonAsync<JsonElement>("/api/gateways");
        Assert.Equal("Living room NAS", list[0].GetProperty("name").GetString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")]   // 101
    public async Task A_blank_or_too_long_name_is_400(string? name)
    {
        var (alice, _, id) = await AliceWithGateway();
        using var _ = alice;
        var res = await alice.PatchAsJsonAsync($"/api/gateways/{id}", new { name });
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("gateway", await NameOf(id));
    }

    [Fact]
    public async Task A_name_of_exactly_100_chars_is_kept()
    {
        var (alice, _, id) = await AliceWithGateway();
        using var _ = alice;
        var res = await alice.PatchAsJsonAsync($"/api/gateways/{id}", new { name = new string('x', 100) });
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
        Assert.Equal(new string('x', 100), await NameOf(id));
    }

    [Fact]
    public async Task A_member_is_403()
    {
        var (alice, tenant, id) = await AliceWithGateway();
        alice.Dispose();
        using var bob = await SignedIn("bob@home.test", tenant);
        Guid bobId;
        using (var bobHome = await SignedIn("bob@home.test"))
        {
            bobId = (await Me(bobHome)).GetProperty("userId").GetGuid();   // provisions bob
        }
        using (var scope = fx.Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
            db.Memberships.Add(new Membership { TenantId = tenant, UserId = bobId, Role = Membership.Member });
            await db.SaveChangesAsync();
        }
        var res = await bob.PatchAsJsonAsync($"/api/gateways/{id}", new { name = "bob's now" });
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal("gateway", await NameOf(id));
    }

    [Fact]
    public async Task Another_households_or_an_unknown_gateway_is_404()
    {
        var (alice, _, id) = await AliceWithGateway();
        using var _ = alice;
        using var bob = await SignedIn("bob@home.test");   // admin of his own household
        var res = await bob.PatchAsJsonAsync($"/api/gateways/{id}", new { name = "mine now" });
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("gateway", await NameOf(id));
        res = await alice.PatchAsJsonAsync($"/api/gateways/{Guid.NewGuid()}", new { name = "x" });
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }
}
