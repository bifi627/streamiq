using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using StreamIq.Api.Auth;
using StreamIq.Api.Data;

namespace StreamIq.Api.Tests.Infrastructure;

/// Sign-up makes no household (#387). Most scenarios still mean "X's own household":
/// this creates it on X's first MeAsync (as its admin, like the web app's Create button),
/// so "the household of X" keeps meaning what it did. Scenarios about having no
/// household read RawMeAsync instead.
public static class OwnHousehold
{
    public static async Task<JsonElement> MeAsync(IntegrationFixture fx, HttpClient client)
    {
        var me = await RawMeAsync(fx, client);
        if (me.GetProperty("memberships").GetArrayLength() > 0)
        {
            return me;
        }
        using var res = await client.PostAsync("/api/households", null);
        res.EnsureSuccessStatusCode();
        return await RawMeAsync(fx, client);
    }

    /// GET /api/me's answer for the client's user, read from the database: the Go API
    /// serves /api/me now, and these tests run the .NET API alone. The request first
    /// signs the user in (adds the users row) like any authenticated call; the household
    /// is the one named, which must be the user's, else the oldest.
    public static async Task<JsonElement> RawMeAsync(IntegrationFixture fx, HttpClient client, Guid? household = null)
    {
        using (var res = await client.GetAsync("/api/gateways"))
        {
            Assert.NotEqual(HttpStatusCode.Unauthorized, res.StatusCode);
        }
        var uid = FirebaseUid(client.DefaultRequestHeaders.Authorization
            ?? throw new InvalidOperationException("client without a token"));
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
        var user = await db.Users.SingleAsync(u => u.FirebaseUid == uid);
        var memberships = await Households.Of(db, user.Id)
            .Join(db.Tenants, m => m.TenantId, t => t.Id, (m, t) => new { id = t.Id, name = t.Name, role = m.Role })
            .ToListAsync();
        var tenant = household is { } h ? memberships.Single(m => m.id == h).id : memberships.FirstOrDefault()?.id;
        return JsonSerializer.SerializeToElement(new { userId = user.Id, tenantId = tenant, memberships });
    }

    // The emulator's tokens are unsigned JWTs: the payload is plain base64url JSON.
    private static string FirebaseUid(AuthenticationHeaderValue bearer)
    {
        var payload = (bearer.Parameter ?? throw new InvalidOperationException("empty bearer")).Split('.')[1].Replace('-', '+').Replace('_', '/');
        payload = payload.PadRight(payload.Length + ((4 - (payload.Length % 4)) % 4), '=');
        return JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(payload)))
            .RootElement.GetProperty("user_id").GetString() ?? throw new InvalidOperationException("token without user_id");
    }
}
