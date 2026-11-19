// #632: while connecting, Chrome reports connectionState 'failed' as soon as
// every candidate pair it has so far has failed, and goes back to 'connecting'
// when the gateway's next candidate arrives. So before the first 'connected',
// only a 'failed' that lasts ends the connect. After it, 'failed' is a lost
// tunnel (e.g. the gateway closed it) and ends it at once, so the next request
// sees a closed pc instead of a data channel that never opens.

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
