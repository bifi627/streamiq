import { describe, type AppError } from '../../errors.ts'

export type Level = 'off' | 'full'

// The card's Health sharing line. label: what the last heartbeat said (null = a
// gateway too old to send a level: no line). control: 'switch' for an admin who can
// reach it (online, paired), 'update' when the gateway can't take the switch (no
// level in its heartbeat, or it answered 404), else none. waiting: a switch to `pending`
// went through but no heartbeat shows it yet (the switch stays disabled meanwhile).
export function telemetryView(x: {
  telemetry: Level | null
  manage: boolean
  tooOld: boolean
  pending: Level | null
}): {
  label: 'on' | 'off' | null
  control: 'switch' | 'update' | null
  waiting: boolean
} {
  const label = x.telemetry && (x.telemetry === 'full' ? 'on' : 'off')
  const waiting = x.pending !== null && x.pending !== x.telemetry
  if (!x.manage) return { label, control: null, waiting }
  if (x.tooOld || !x.telemetry) return { label, control: 'update', waiting }
  return { label, control: 'switch', waiting }
}

// A failed switch: 404 = a gateway older than the endpoint, else the error's line.
export const switchOutcome = (
  e: AppError,
): { tooOld: true } | { msg: string } =>
  e.context.status === 404 ? { tooOld: true } : { msg: describe(e).message }
