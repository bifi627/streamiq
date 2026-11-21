namespace StreamIq.Api.Data;

public class Tenant
{
    public Guid Id { get; set; }
    public string? Name { get; set; }               // cosmetic
    public DateTimeOffset CreatedAt { get; set; }
}

public class AppUser
{
    public Guid Id { get; set; }                    // our PK — never the Firebase UID
    public required string FirebaseUid { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// A user's place in a household (tenant). A user can belong to several; the
/// request picks one (Auth/Households). Tenant-owned, so the global filter scopes
/// it like any other table; only Households looks a user's memberships up across
/// tenants.
public class Membership : ITenantOwned
{
    public const string Admin = "admin", Member = "member";
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public required string Role { get; set; }          // Admin / Member (CHECK constraint)
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
    public int? Protocol { get; set; }                  // gateway protocol from its last heartbeat (also a refused one)
    public string? Telemetry { get; set; }              // off / full, from the last heartbeat; null = a gateway too old to send it
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

/// A one-time link that adds its holder to the household as a member.
/// Only the SHA-256 hash is stored; the plaintext lives in the link for 7 days.
public class Invite : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public required string TokenHash { get; set; }
    public Guid? CreatedBy { get; set; }                // users.id of the inviting admin (named in the preview, looked up in Firebase)
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? UsedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// One tunnel: the WebRTC connection from a client to a gateway. The broker writes the
/// row and its end, the gateway reports route + bytes, the client only its throughput.
public class Tunnel : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid GatewayId { get; set; }
    public Guid? UserId { get; set; }                   // who opened it (users.id); null = an older row, or the user was deleted
    // Route + bytes + failure: the gateway's report at the tunnel's end; all unset
    // until it arrives (an older gateway never sends one). BytesSent null = not reported yet.
    public bool Relay { get; set; }                     // either side's selected candidate is a relay
    public bool Ipv6 { get; set; }
    public string? LocalCandidateType { get; set; }     // host / srflx / prflx / relay; local = the gateway's side
    public string? RemoteCandidateType { get; set; }    // the browser's side
    public string? Protocol { get; set; }               // udp / tcp
    public long? BytesReceived { get; set; }            // as the gateway counts: received = client → gateway
    public long? BytesSent { get; set; }                // gateway → client
    public int? ThroughputKbps { get; set; }            // the client's gateway → client measurement; null = none finished
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }        // the broker: the browser's signaling socket closed
    public string? Failure { get; set; }                // why it never came up / passed auth (no pair: Relay/types unset); null = it did, but only when reported (BytesSent not null)
    public string? Use { get; set; }                    // what it was for (playback / browsing / …: an open word, docs/protocol.md); null = no request served, or not reported
    public long? ActiveMs { get; set; }                 // the gateway's clock: from the offer to its last request's end; null like Use
}

/// The box's health at `full` telemetry (docs/protocol.md): a row when it changes, and at
/// least every 5 minutes. The gateway's latest row is its current state. Null = not sent.
public class GatewayHealth : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid GatewayId { get; set; }
    public DateTimeOffset At { get; set; }
    public required string Level { get; set; }          // the telemetry level that sent it
    public bool? JellyfinReachable { get; set; }
    public string? JellyfinVersion { get; set; }
    public string? Os { get; set; }
    public string? Arch { get; set; }
    public string? Transcoding { get; set; }            // hardware acceleration: none / nvenc / …
    public string? Offline { get; set; }                // the offline jail: enforced / allowed
    public int? Tunnels { get; set; }                   // active tunnels
    public int? Transcodes { get; set; }                // active Jellyfin transcodes
    public double? Cpu { get; set; }                    // busy %, 0–100
    public double? Memory { get; set; }                 // used %, 0–100
}
