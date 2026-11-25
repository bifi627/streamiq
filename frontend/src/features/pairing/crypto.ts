// Pure pairing crypto, mirrored by gateway/internal/pairing (docs/protocol.md,
// "Pairing"). No imports, so node --test runs it against the shared vectors.

const enc = new TextEncoder()

export const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

export const b64 = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))

export const sha256 = (s: string | ArrayBuffer) =>
  crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s)

/** Contract form `sha-256 AA:BB:…` over raw bytes (e.g. SPKI). */
export async function fingerprint(bytes: ArrayBuffer) {
  return (
    'sha-256 ' +
    (
      hex(await sha256(bytes))
        .toUpperCase()
        .match(/../g) ?? []
    ).join(':')
  )
}

/**
 * The one `a=fingerprint:sha-256 …` of an SDP, normalized to the contract form.
 * Throws unless every fingerprint line (session and media level, any hash) is
 * the same sha-256 one: with several, the value compared with the pin need not
 * be the one the browser's DTLS stack verifies.
 */
export function sdpFingerprint(sdp: string) {
  const lines = new Set(
    sdp
      .split(/[\r\n]+/)
      .filter((l) => /a=fingerprint/i.test(l))
      .map((l) => l.trim().toLowerCase()),
  )
  if (lines.size !== 1)
    throw new Error(`SDP with ${lines.size} distinct fingerprints, expected 1`)
  const m = /^a=fingerprint:sha-256 ([0-9a-f:]+)$/.exec([...lines][0])
  if (!m) throw new Error('SDP fingerprint is not a sha-256 one')
  return 'sha-256 ' + m[1].toUpperCase()
}

/** What the client key signs: bound to both DTLS fingerprints of this session. */
export const authMessage = (
  gatewayDtlsFp: string,
  browserDtlsFp: string,
  n: string,
) => enc.encode(`streamiq-auth-v1|${gatewayDtlsFp}|${browserDtlsFp}|${n}`)

/** What the gateway's identity key signs in its challenge: the same session binding. */
export const gatewayMessage = (
  gatewayDtlsFp: string,
  browserDtlsFp: string,
  n: string,
) => enc.encode(`streamiq-gateway-v1|${gatewayDtlsFp}|${browserDtlsFp}|${n}`)

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * The challenge's proof: the identity key's fingerprint (what the pin is) when
 * its signature covers this session, else undefined. A MITM terminating DTLS
 * itself shows us other fingerprints than the ones the gateway signed.
 */
export async function verifyProof(
  spki: string,
  sig: string,
  gatewayDtlsFp: string,
  browserDtlsFp: string,
  n: string,
): Promise<string | undefined> {
  try {
    const raw = unb64(spki)
    const key = await crypto.subtle.importKey(
      'spki',
      raw,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      unb64(sig),
      gatewayMessage(gatewayDtlsFp, browserDtlsFp, n),
    )
    return ok ? await fingerprint(raw.buffer) : undefined
  } catch {
    return undefined // not base64, or not a P-256 key
  }
}

/** 6-digit comparison code over the committed nonces; gatewayKeyFp is the pin. */
export async function comparisonCode(
  gatewayKeyFp: string,
  keyFp: string,
  nA: string,
  nB: string,
) {
  const h = await sha256(`${gatewayKeyFp}|${keyFp}|${nA}|${nB}`)
  return String(new DataView(h).getUint32(0) % 1_000_000).padStart(6, '0')
}

export const nonce = () => hex(crypto.getRandomValues(new Uint8Array(32)))

/**
 * The browser's pin decision for the gateway's proven identity key:
 * - `pinned`: matches the pin → the gateway's plain "ok" may be trusted
 * - `unpinned`: no pin, or pairing again → only the code comparison may vouch
 *   for this key (auth carries `pair: true`)
 * - `refuse`: mismatch outside pairing → stop before sending our key
 */
export function pinCheck(
  pin: string | undefined,
  gatewayKeyFp: string,
  pairing: boolean,
): 'pinned' | 'unpinned' | 'refuse' {
  if (pin === gatewayKeyFp) return 'pinned'
  return pin && !pairing ? 'refuse' : 'unpinned'
}

/**
 * The gateway's DTLS fingerprint from its answer SDP (fresh every tunnel: the
 * challenge's proof covers it), or why the answer is refused.
 */
export function answerCheck(sdp: string): { fp: string } | { refused: string } {
  try {
    return { fp: sdpFingerprint(sdp) }
  } catch (e) {
    // No single certificate for the proof to cover: refuse like a mismatch.
    return { refused: `gateway answer refused: ${(e as Error).message}` }
  }
}
