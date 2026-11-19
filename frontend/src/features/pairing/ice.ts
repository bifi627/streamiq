// "Force relay over TLS (443)" (#576): keep only the `turns:…:443` URLs of the
// broker's ICE servers, so a test proves the TLS relay a 443-only network needs
// (Cloudflare also hands out turns: on 5349, which such a network blocks). None →
// no servers: the test reports the ICE failure instead of falling back.
type IceServer = { urls: string | string[]; [k: string]: unknown }

export function tlsOnly(servers: IceServer[]): IceServer[] {
  return servers.flatMap((s) => {
    const urls = [s.urls].flat().filter((u) => /^turns:[^?]*:443(\?|$)/.test(u))
    return urls.length ? [{ ...s, urls }] : []
  })
}
