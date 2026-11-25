// The pairing block's state and what it shows (Pairing.tsx wires it).
import type { AppError } from '../../shared/errors'
import type { SystemInfo } from '../library/jellyfin'
import type { PairInfo } from '../../shared/stats'

export type State =
  | { step: 'idle' }
  | { step: 'connecting'; pair: boolean }
  // matched: the user said the gateway shows this code too.
  | { step: 'code'; code: string; matched: boolean }
  | { step: 'done'; paired: boolean; info: SystemInfo; path: PairInfo | null }
  | { step: 'failed'; err: AppError }

/** No usable pin for the gateway (refused, or a pairing whose codes didn't
 * match): Pair again, not Test. */
export const pinUnusable = (e: AppError) =>
  e.kind === 'not-paired' ||
  e.kind === 'pin-mismatch' ||
  e.kind === 'code-mismatch'

/** Pair shows while this browser has no usable pin. */
export const showPair = (
  s: State,
  pinned: boolean | null,
  needsPair?: boolean,
) =>
  !!needsPair ||
  pinned === false ||
  (s.step === 'failed' && pinUnusable(s.err)) ||
  (s.step === 'connecting' && s.pair) || // stays put while it runs
  s.step === 'code'

/** The Route fact of a passed test. */
export const routeLine = (path: PairInfo | null) =>
  (!path ? 'unknown' : path.relay ? 'relayed (TURN)' : 'direct') +
  (path?.rttMs !== undefined
    ? ` · ${path.rttMs.toLocaleString()} ms round trip`
    : '')
