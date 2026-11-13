// IndexedDB: this browser's client key (non-extractable CryptoKey — script on
// the page can use it but never read it out) and the gateway pins, per gateway id.
import { fingerprint } from './crypto'
import { event } from '../../diag'

const db = new Promise<IDBDatabase>((resolve, reject) => {
  const r = indexedDB.open('streamiq', 1)
  r.onupgradeneeded = () => r.result.createObjectStore('kv')
  r.onsuccess = () => resolve(r.result)
  r.onerror = () => reject(r.error)
})

async function kv<T>(
  mode: IDBTransactionMode,
  f: (s: IDBObjectStore) => IDBRequest,
) {
  const s = (await db).transaction('kv', mode).objectStore('kv')
  return new Promise<T>((resolve, reject) => {
    const r = f(s)
    r.onsuccess = () => resolve(r.result as T)
    r.onerror = () => reject(r.error)
  })
}

export type ClientKey = { privateKey: CryptoKey; spki: ArrayBuffer; fp: string }

/** Created once per browser profile. Lost (site data cleared) = re-pair. */
export async function clientKey(): Promise<ClientKey> {
  const have = await kv<ClientKey | undefined>('readonly', (s) =>
    s.get('clientKey'),
  )
  if (have) return have
  const k = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const spki = await crypto.subtle.exportKey('spki', k.publicKey)
  const key = { privateKey: k.privateKey, spki, fp: await fingerprint(spki) }
  await kv('readwrite', (s) => s.put(key, 'clientKey'))
  return key
}

export const getPin = (gatewayId: string) =>
  kv<string | undefined>('readonly', (s) => s.get(`pin:${gatewayId}`))

export const setPin = (gatewayId: string, gatewayFp: string) =>
  kv('readwrite', (s) => s.put(gatewayFp, `pin:${gatewayId}`))

/** Asks the browser not to evict our storage (#174): best-effort storage can go
 * under disk pressure, and Safari drops it after 7 days without a visit; either
 * way the client key is gone and the browser must pair again. Called after a
 * pairing, not at key creation: Firefox prompts, and pairing is a deliberate act. */
export async function persistStorage() {
  const s = navigator.storage
  if (!s?.persist) return event('storage: persist() unsupported')
  if (await s.persisted()) return event('storage: already persistent')
  event(`storage: persist() ${(await s.persist()) ? 'granted' : 'denied'}`)
}
