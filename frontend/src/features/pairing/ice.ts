// "Force relay over TLS (443)" (#576): keep only the `turns:` URLs of the broker's
// ICE servers, so a test proves the TLS relay a 443-only network needs. No `turns:`
// URL → no servers: the test reports the ICE failure instead of falling back to UDP.
type IceServer = { urls: string | string[]; [k: string]: unknown }

export function tlsOnly(servers: IceServer[]): IceServer[] {
  return servers.flatMap((s) => {
    const urls = [s.urls].flat().filter((u) => u.startsWith('turns:'))
    return urls.length ? [{ ...s, urls }] : []
  })
}
