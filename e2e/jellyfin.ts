// Completes Jellyfin's first-run wizard over its HTTP API (admin JELLYFIN_ADMIN)
// and adds the /media (Movies), /shows (Shows) + /e2e-photos (Photos)
// libraries. The gateway then connects the real way: an admin login on its
// local page (stack.ts), which gives it its viewer token. The preview leaves the wizard to the gateway
// (managed, as on an install) and only adds the libraries (addLibraries).
// Test-only.
const AUTH =
  'MediaBrowser Client="streamiq-e2e", Device="e2e", DeviceId="streamiq-e2e", Version="1"'

export const JELLYFIN_ADMIN = { user: 'streamiq', pw: 'streamiq-e2e' }

/** GET as the e2e admin: per-user state the gateway's viewers left. */
export async function jellyfinAdminGet(base: string, path: string) {
  const login = await fetch(base + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    body: JSON.stringify({
      Username: JELLYFIN_ADMIN.user,
      Pw: JELLYFIN_ADMIN.pw,
    }),
  }).then((r) => r.json())
  const res = await fetch(base + path, {
    headers: { Authorization: `${AUTH}, Token="${login.AccessToken}"` },
  })
  if (!res.ok) throw new Error(`jellyfin ${path}: HTTP ${res.status}`)
  return res.json()
}

const client = (base: string) => {
  const call = async (path: string, init: RequestInit = {}, token?: string) => {
    const res = await fetch(base + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: AUTH + (token ? `, Token="${token}"` : ''),
      },
    })
    if (!res.ok) throw new Error(`jellyfin ${path}: HTTP ${res.status}`)
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }
  const post = (path: string, body: unknown, token?: string) =>
    call(path, { method: 'POST', body: JSON.stringify(body) }, token)
  return { call, post }
}

export async function setupJellyfin(
  base: string,
  step = (_: string) => {}, // logs the time each step took (stack.ts)
): Promise<void> {
  const { post, call } = client(base)
  // Waits for Jellyfin's start: the jail's forwarder accepts at once and closes
  // the socket ("fetch failed") until Jellyfin listens, then the wizard returns
  // 503 until the server is fully up.
  for (let i = 0; ; i++) {
    try {
      await post('/Startup/Configuration', {
        UICulture: 'en-US',
        MetadataCountryCode: 'US',
        PreferredMetadataLanguage: 'en',
      })
      break
    } catch (e) {
      if (i >= 180 || !/HTTP 503|fetch failed/.test(String(e))) throw e
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  await call('/Startup/User') // the wizard creates the first user lazily on GET
  await post('/Startup/User', {
    Name: JELLYFIN_ADMIN.user,
    Password: JELLYFIN_ADMIN.pw,
  })
  await post('/Startup/RemoteAccess', { EnableRemoteAccess: true })
  await post('/Startup/Complete', {})
  step('wizard')
  await addLibraries(base, JELLYFIN_ADMIN, step, [
    ['Photos', 'homevideos', '/e2e-photos'],
  ])
}

/** Adds the Movies + Shows libraries (+ `extra`: [name, collectionType, path],
 * a photo library) as `admin` and waits for their scan. */
export async function addLibraries(
  base: string,
  admin: { user: string; pw: string },
  step = (_: string) => {},
  extra: [string, string, string][] = [],
): Promise<void> {
  const { post, call } = client(base)
  const login = await post('/Users/AuthenticateByName', {
    Username: admin.user,
    Pw: admin.pw,
  })
  const token: string = login.AccessToken
  for (const [name, type, dir] of [
    ['Movies', 'movies', '/media'],
    ['Shows', 'tvshows', '/shows'],
    ...extra,
  ])
    await post(
      `/Library/VirtualFolders?name=${name}&collectionType=${type}&paths=${encodeURIComponent(dir)}&refreshLibrary=true`,
      { LibraryOptions: { EnableInternetProviders: false } },
      token,
    )

  // The scan is async, and the one refreshLibrary=true starts can race the new
  // library's options (it then indexes /media as a plain folder): re-kick a
  // full refresh every 10 s until the fixture shows up.
  for (let i = 0; i < 120; i++) {
    if (i % 10 === 0) await call('/Library/Refresh', { method: 'POST' }, token)
    const count = (type: string) =>
      call(
        `/Items?userId=${login.User.Id}&recursive=true&includeItemTypes=${type}`,
        {},
        token,
      ).then((r) => r.TotalRecordCount)
    // All 3 movies and 4 episodes (stack.ts): a half-scanned series has no
    // next one yet. A photo library: at least the e2e's 4 photos.
    if (
      (await count('Movie')) >= 3 &&
      (await count('Episode')) >= 4 &&
      (!extra.length || (await count('Photo')) >= 4)
    )
      return step('scan')
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('jellyfin: library scan found no media after 120s')
}
