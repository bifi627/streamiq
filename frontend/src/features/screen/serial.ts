// One tunnel POST at a time, in order: the screen's state POSTs and the
// phone remote's commands (Screen.tsx).

/** Runs one at a time, in order (each tunnel POST is its own channel, so only
 * waiting keeps them ordered). A new x replaces the queued last one if
 * replaces(last, x). A rejected run is dropped here: the caller's run reports
 * its own error. */
export function serial<T extends string | object>(
  run: (x: T) => Promise<unknown>,
  replaces: (queued: T, x: T) => boolean,
) {
  const q: T[] = []
  let busy = false
  const next = () => {
    const x = q.shift() // T excludes undefined: undefined = queue empty
    busy = x !== undefined
    if (x !== undefined)
      run(x)
        .catch(() => {
          // reported on the caller's path: the tunnel request log or its own handler
        })
        .finally(next)
  }
  return (x: T) => {
    if (q.length && replaces(q[q.length - 1], x)) q.pop()
    q.push(x)
    if (!busy) next()
  }
}
