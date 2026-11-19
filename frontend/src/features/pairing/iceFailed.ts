// #632: Chrome reports connectionState 'failed' as soon as every candidate pair
// it has so far has failed, and goes back to 'connecting' when the gateway's next
// candidate arrives. So only a 'failed' that lasts ends the connect.

export const ICE_FAILED_GRACE_MS = 5000

/** Feed it every connectionState: onFail runs once 'failed' has lasted `ms`;
 * any other state before then cancels it. */
export function lastingFailure(
  onFail: () => void,
  ms = ICE_FAILED_GRACE_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (state: RTCPeerConnectionState) => {
    if (state === 'failed') timer ??= setTimeout(onFail, ms)
    else {
      clearTimeout(timer)
      timer = undefined
    }
  }
}
