namespace StreamIq.Api.Data;

public class Tenant
{
    public Guid Id { get; set; }
    public string? Name { get; set; }               // cosmetic; owner is implicit (the one user)
    public DateTimeOffset CreatedAt { get; set; }
}

public class AppUser
{
    public Guid Id { get; set; }                    // our PK — never the Firebase UID
    public required string FirebaseUid { get; set; }
    public Guid TenantId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public class Gateway : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public string? Name { get; set; }
    public string? DtlsFingerprint { get; set; }        // gateway's persistent DTLS cert, set at enrollment; pinned
    public string? CredentialHash { get; set; }    // SHA-256 hex of the gateway credential (never the plaintext)
    public string? LanUrl { get; set; }                 // gateway page on the home LAN, from heartbeat
    public string? Version { get; set; }                // gateway release version, from heartbeat
    public DateTimeOffset? LastSeenAt { get; set; }      // heartbeat → online/offline
    public string? Update { get; set; }                 // newer gateway release, from heartbeat; null = up to date
    public DateTimeOffset CreatedAt { get; set; }
}

/// One-time gateway enrollment token (onboarding flow 1). Only the SHA-256 hash
/// is stored; the plaintext lives in the install command for 15 minutes.
public class EnrollmentToken : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public required string TokenHash { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? UsedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// One WebRTC session from a client to a gateway (connection telemetry, a
/// deliverable: checkpoints query direct-vs-relay and IPv4/v6 rates here).
/// Written by the client: POST on connect, PATCH with totals on close.
public class ConnectionSession : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid GatewayId { get; set; }
    public bool Relay { get; set; }                     // either side's selected candidate is a relay
    public bool Ipv6 { get; set; }
    public string? LocalCandidateType { get; set; }     // host / srflx / prflx / relay
    public string? RemoteCandidateType { get; set; }
    public string? Protocol { get; set; }               // udp / tcp
    public long? BytesReceived { get; set; }
    public long? BytesSent { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    public string? Failure { get; set; }                // null = tunnel came up; else why the attempt failed (no pair: Relay/types unset)
}
