using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using StreamIq.Api.Data;
using StreamIq.Api.Tests.Infrastructure;

namespace StreamIq.Api.Tests.Features.Gateways;

[Collection("integration")]
public class ListGatewaysTests(IntegrationFixture fx)
{
    private async Task<HttpClient> SignedInClient(string email)
    {
        var token = await TokenMinter.MintIdTokenAsync(fx.EmulatorHost, email, "password123");
        var client = fx.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    [Fact]
    public async Task A_tenant_never_sees_another_tenants_gateway_over_http()
    {
        await fx.ResetAsync();

        // Tenant A signs in (provisions), then gets a gateway seeded into its tenant.
        using var clientA = await SignedInClient("a@x.test");
        await clientA.GetAsync("/me");                       // provision A
        using (var scope = fx.Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
            var tenantAId = db.Users.Single(u => u.Email == "a@x.test").TenantId;
            db.Gateways.Add(new Gateway { TenantId = tenantAId, Name = "a-box", CredentialHash = "seeded" });
            await db.SaveChangesAsync();
        }

        // Tenant A sees its gateway; tenant B sees nothing.
        var aGateways = await clientA.GetFromJsonAsync<JsonElement>("/gateways");
        Assert.Equal(1, aGateways.GetArrayLength());

        using var clientB = await SignedInClient("b@x.test");
        var bGateways = await clientB.GetFromJsonAsync<JsonElement>("/gateways");
        Assert.Equal(0, bGateways.GetArrayLength());
    }
}
