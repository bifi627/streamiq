// Guest mode (#242): the gateway couldn't make this user's own Jellyfin viewer,
// so the session plays as the shared one. null = no banner (own viewer, or an
// older gateway that doesn't say).
export function guestNotice(
  s: { viewer?: { shared?: boolean; reason?: string } } | null, // GatewayStatus
  admin: boolean,
): string | null {
  if (s?.viewer?.shared !== true) return null
  const why = s.viewer.reason ? ` (${s.viewer.reason})` : ''
  return (
    `Couldn't load your profile${why}. You're watching in guest mode: your progress isn't saved to your profile. ` +
    (admin
      ? "Check the gateway's local page (linked on the Gateways list)."
      : 'Ask a household admin to check the gateway.')
  )
}
