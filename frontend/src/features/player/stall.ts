// The stall spinner: on while the picture waits for data (buffering, a
// reload, a replaced tunnel), off once it plays or can't be waiting anymore.
// No imports, so node:test runs it.

/** The video events that switch it. */
export const STALL_EVENTS = [
  'waiting',
  'playing',
  'canplay',
  'seeked',
  'pause',
  'ended',
  'error',
]

/** On after a video event of this type? */
export const stalls = (type: string) => type === 'waiting'
