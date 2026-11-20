import type { TunnelRow } from './tunnels'

// GET /api/tunnels/summary (admin): per user, the last 30 days, every row.
export type SummaryRow = {
  userId: string | null // null = deleted accounts
  tunnels: number
  hidden: number // management / diagnostics that didn't fail: byUse's hidden rows
  failed: number
  relayedBytes: number
}

/** names: memberNames() of the members endpoint; undefined while it loads. */
export function memberLabel(
  userId: string | null | undefined,
  names: Map<string, string> | undefined,
): string {
  if (!userId) return 'Deleted account'
  if (!names) return '…'
  return names.get(userId) ?? 'Former member'
}

/** The rows of one user; '' = everyone. */
export const byMember = (rows: TunnelRow[], userId: string) =>
  userId ? rows.filter((t) => t.userId === userId) : rows

/** The summary's tunnel count follows the table's checkbox: without `all`, no hidden ones. */
export const shownTunnels = (s: SummaryRow, all: boolean) =>
  all ? s.tunnels : s.tunnels - s.hidden

/** An admin's Activity opens on the whole household. */
export const tunnelsPath = (admin: boolean) =>
  admin ? '/tunnels?scope=household' : '/tunnels'
