// The selected ICE candidate pair, from a getStats() report. Feeds the privacy
// indicator and connection telemetry. Pure (no DOM types) so node --test runs it.
type Stats = ReadonlyMap<string, Record<string, any>>

export type PairInfo = {
  relay: boolean
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
