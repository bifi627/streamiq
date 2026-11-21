using System.Security.Cryptography;
using System.Text;

namespace StreamIq.Api.Features.Invites;

/// Invite secrets: random, URL-safe,
/// stored server-side as SHA-256 hex only — never the plaintext.
public static class Secrets
{
    public static string New(int bytes)
    {
        return Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public static string Hash(string secret)
    {
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(secret)));
    }
}
