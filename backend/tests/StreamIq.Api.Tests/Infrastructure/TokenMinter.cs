using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace StreamIq.Api.Tests.Infrastructure;

/// Mint a real Firebase ID token via the Auth emulator's Identity Toolkit REST
/// API. The token flows through the production VerifyIdTokenAsync path — no bypass.
public static class TokenMinter
{
    public static async Task<string> MintIdTokenAsync(string emulatorHost, string email, string password)
    {
        using var http = new HttpClient();
        var payload = new { email, password, returnSecureToken = true };

        var signUpUrl = $"http://{emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key";
        var signUpResp = await http.PostAsJsonAsync(signUpUrl, payload);
        if (signUpResp.IsSuccessStatusCode)
        {
            return (await signUpResp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("idToken").GetString()
                ?? throw new InvalidOperationException("emulator response without idToken");
        }

        // The emulator's users aren't reset by IntegrationFixture.ResetAsync (that
        // only truncates Postgres), so a scenario that signs the same email in more
        // than once hits an already-provisioned account. Fall back to the sign-in
        // endpoint for that case — still a real emulator round trip, still verified
        // through the production path, just the "returning user" leg instead of
        // "first ever sign-up".
        // ponytail: substring match, not a parse: a non-JSON/odd body can't throw here and mask the real failure (#39).
        var errorBody = await signUpResp.Content.ReadAsStringAsync();
        if (signUpResp.StatusCode != HttpStatusCode.BadRequest || !errorBody.Contains("EMAIL_EXISTS"))
        {
            throw new HttpRequestException($"emulator signUp failed: {(int)signUpResp.StatusCode} {errorBody}");
        }

        var signInUrl = $"http://{emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key";
        var signInResp = await http.PostAsJsonAsync(signInUrl, payload);
        if (!signInResp.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"emulator signIn failed: {(int)signInResp.StatusCode} {await signInResp.Content.ReadAsStringAsync()}");
        }
        return (await signInResp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("idToken").GetString()
                ?? throw new InvalidOperationException("emulator response without idToken");
    }

    /// Google sign-in (#66) via the emulator's `signInWithIdp`: it accepts the Google
    /// id_token as plain JSON claims (what its fake popup sends), no real Google project.
    public static async Task<string> MintGoogleIdTokenAsync(string emulatorHost, string sub, string email)
    {
        using var http = new HttpClient();
        var claims = JsonSerializer.Serialize(new { sub, email, email_verified = true, name = "G User", picture = "https://x.test/p.png" });
        var payload = new
        {
            requestUri = "http://localhost",
            returnSecureToken = true,
            postBody = $"id_token={Uri.EscapeDataString(claims)}&providerId=google.com",
        };
        var url = $"http://{emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake-api-key";
        var resp = await http.PostAsJsonAsync(url, payload);
        if (!resp.IsSuccessStatusCode)
        {
            throw new HttpRequestException($"emulator signInWithIdp failed: {(int)resp.StatusCode} {await resp.Content.ReadAsStringAsync()}");
        }
        return (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("idToken").GetString()
                ?? throw new InvalidOperationException("emulator response without idToken");
    }
}
