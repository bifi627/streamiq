import type { Usage } from '../../generated/relayusage'

/** A removed gateway's bytes still count; its name may be gone. */
export const relayLabel = (u: Usage) =>
  u.removed ? 'Removed gateway' : (u.name ?? 'Unnamed gateway')
