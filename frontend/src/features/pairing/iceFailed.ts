// quirk(#632): while connecting, Chrome reports 'failed' once every candidate
// pair so far failed, and 'connecting' again on the gateway's next candidate.
// After a 'connected', 'failed' is a lost tunnel: end it at once, so the next
// request sees a closed pc, not a data channel that never opens.

export const ICE_FAILED_GRACE_MS = 5000

/** Feed it every connectionState: onFail runs on 'failed' after a 'connected',
 * or once a 'failed' before it has lasted `ms` (any other state cancels that). */
export function lastingFailure(onFail: () => void, ms = ICE_FAILED_GRACE_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let up = false
  return (state: RTCPeerConnectionState) => {
    if (state === 'connected') up = true
    if (state === 'failed' && up) return onFail()
    if (state === 'failed') timer ??= setTimeout(onFail, ms)
    else {
      clearTimeout(timer)
      timer = undefined
    }
  }
}
