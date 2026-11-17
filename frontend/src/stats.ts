// The selected ICE candidate pair, from a getStats() report. Feeds the privacy
// indicator and connection telemetry. Pure (no DOM types) so node --test runs it.
type Stats = ReadonlyMap<string, Record<string, any>>

export type PairInfo = {
  relay: boolean
  /** host ↔ host, both on private / link-local / mDNS addresses (#428) */
  lan: boolean
  ipv6: boolean
  local?: string
  remote?: string
  protocol?: string
  bytesReceived: number
  bytesSent: number
  /** current round-trip time of the pair, ms (absent until measured) */
  rttMs?: number
}

export function pairInfo(report: Stats): PairInfo | null {
  const all = [...report.values()]
  // Chrome/Safari: transport.selectedCandidatePairId; Firefox: pair.selected.
  const id = all.find((s) => s.type === 'transport')?.selectedCandidatePairId
  const pair = all.find(
    (s) => s.type === 'candidate-pair' && (s.id === id || s.selected),
  )
  if (!pair) return null
  const local = report.get(pair.localCandidateId)
  const remote = report.get(pair.remoteCandidateId)
  return {
    // Chrome can report the selected relayed local candidate as prflx; only
    // relay candidates carry relayProtocol.
    relay:
      local?.candidateType === 'relay' ||
      local?.relayProtocol != null ||
      remote?.candidateType === 'relay',
    lan:
      local?.candidateType === 'host' &&
      remote?.candidateType === 'host' &&
      ((isPrivate(local) && isPrivate(remote)) || sameV6Link(local, remote)),
    ipv6: String(local?.address ?? local?.ip ?? '').includes(':'),
    local: local?.candidateType,
    remote: remote?.candidateType,
    protocol: local?.protocol,
    bytesReceived: pair.bytesReceived ?? 0,
    bytesSent: pair.bytesSent ?? 0,
    rttMs:
      pair.currentRoundTripTime == null
        ? undefined
        : Math.round(pair.currentRoundTripTime * 1000),
  }
}

// A host candidate is any interface address, global IPv6 and public IPv4
// included, so host ↔ host alone doesn't mean the home network (#428).
// Private addresses, or two global IPv6 addresses in one /64 (one link) are.
// ponytail: RFC 1918 + link-local + ULA + mDNS; CGNAT/VPN ranges read as direct.
const addr = (c?: Record<string, any>) =>
  String(c?.address ?? c?.ip ?? '').toLowerCase()

function isPrivate(c?: Record<string, any>): boolean {
  const a = addr(c)
  return /\.local$|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^f[cd]|^fe[89ab]/.test(
    a,
  )
}

// The /64 prefix of an IPv6 address ('' for anything else).
function prefix64(a: string): string {
  if (!a.includes(':')) return ''
  const [head, tail = ''] = a.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const all = a.includes('::')
    ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
    : h
  return all
    .slice(0, 4)
    .map((x) => parseInt(x, 16))
    .join(':')
}

function sameV6Link(l?: Record<string, any>, r?: Record<string, any>): boolean {
  const p = prefix64(addr(l))
  return p !== '' && p === prefix64(addr(r))
}

/** The privacy badge's state (#428). */
export function route(p: PairInfo): 'lan' | 'direct' | 'relay' {
  return p.relay ? 'relay' : p.lan ? 'lan' : 'direct'
}
