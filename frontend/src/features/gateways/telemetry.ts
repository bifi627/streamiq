export type Level = 'off' | 'full'

// The card's Health sharing line. label: what the last heartbeat said (null = no
// level: no line at all). toggle: an admin who can reach the gateway (online,
// paired) gets the switch. waiting: a switch to `pending` went through but no
// heartbeat shows it yet (the switch stays disabled meanwhile).
export function telemetryView(x: {
  telemetry: Level | null
  manage: boolean
  pending: Level | null
}): { label: 'on' | 'off' | null; toggle: boolean; waiting: boolean } {
  const label = x.telemetry && (x.telemetry === 'full' ? 'on' : 'off')
  return {
    label,
    toggle: x.manage && label !== null,
    waiting: x.pending !== null && x.pending !== x.telemetry,
  }
}
