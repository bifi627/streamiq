// Guest mode (#242): the gateway couldn't make this user's own Jellyfin viewer,
// so the session plays as the shared one. null = no banner (own viewer, or an
// older gateway that doesn't say).
export function guestNotice(
  s: { viewer?: { shared?: boolean; reason?: string } } | null, // GatewayStatus
  admin: boolean,
): string | null {
  if (s?.viewer?.shared !== true) return null
  const why = REASONS[s.viewer.reason ?? ''] // unknown code (newer gateway): no reason
  return (
    `Couldn't load your profile${why ? ` (${why})` : ''}. You're watching in guest mode: your progress isn't saved to your profile. ` +
    (admin
      ? "Check the gateway's local page (linked on the Gateways list)."
      : 'Ask a household admin to check the gateway.')
  )
}

// GET /streamiq/status viewer.reason codes (docs/protocol.md).
const REASONS: Record<string, string> = {
  'admin-refused': "Jellyfin refused the gateway's administrator sign-in",
  'no-admin': 'the gateway has no Jellyfin administrator of its own',
  failed:
    "the gateway couldn't create your Jellyfin user; it tries again on your next connection",
}
