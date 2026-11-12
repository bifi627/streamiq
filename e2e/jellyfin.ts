// Completes Jellyfin's first-run wizard over its HTTP API (admin JELLYFIN_ADMIN)
// and adds the /media library. The gateway then connects the real way: an admin
// login on its local page (stack.ts), which gives it its viewer token. Test-only.
const AUTH =
  'MediaBrowser Client="streamiq-e2e", Device="e2e", DeviceId="streamiq-e2e", Version="1"'

export const JELLYFIN_ADMIN = { user: 'streamiq', pw: 'streamiq-e2e' }

export async function setupJellyfin(
  base: string,
  nvenc = false,
): Promise<void> {
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

  // /System/Info/Public answers before the server is fully up; the wizard
  // returns 503 until then.
  for (let i = 0; ; i++) {
    try {
      await post('/Startup/Configuration', {
        UICulture: 'en-US',
        MetadataCountryCode: 'US',
        PreferredMetadataLanguage: 'en',
      })
      break
    } catch (e) {
      if (i >= 60 || !String(e).includes('HTTP 503')) throw e
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

  const login = await post('/Users/AuthenticateByName', {
    Username: JELLYFIN_ADMIN.user,
    Pw: JELLYFIN_ADMIN.pw,
  })
  const token: string = login.AccessToken
  if (nvenc) {
    // The preview's GPU (stack.ts): the core of the gateway's hwAccel("nvenc")
    // (gateway/internal/jellyfin), set as the admin since the gateway doesn't
    // manage a Jellyfin it didn't set up.
    const enc = await call('/System/Configuration/encoding', {}, token)
    await post(
      '/System/Configuration/encoding',
      {
        ...enc,
        HardwareAccelerationType: 'nvenc',
        HardwareDecodingCodecs: [
          'h264',
          'hevc',
          'mpeg2video',
          'vc1',
          'vp8',
          'vp9',
          'av1',
        ],
        EnableDecodingColorDepth10Hevc: true,
        EnableDecodingColorDepth10Vp9: true,
        EnableEnhancedNvdecDecoder: true,
        EnableHardwareEncoding: true,
        EnableTonemapping: true,
        EncoderPreset: 'fast', // "auto" is NVENC's lowest quality (p1)
        EnableThrottling: true, // the gateway's configSteps (#82)
        EnableSegmentDeletion: true,
      },
      token,
    )
  }
  await post(
    '/Library/VirtualFolders?name=Movies&collectionType=movies&paths=%2Fmedia&refreshLibrary=true',
    { LibraryOptions: { EnableInternetProviders: false } },
    token,
  )

  // The scan is async, and the one refreshLibrary=true starts can race the new
  // library's options (it then indexes /media as a plain folder): re-kick a
  // full refresh every 10 s until the fixture shows up.
  for (let i = 0; i < 120; i++) {
    if (i % 10 === 0) await call('/Library/Refresh', { method: 'POST' }, token)
    const items = await call(
      `/Items?userId=${login.User.Id}&recursive=true&includeItemTypes=Movie`,
      {},
      token,
    )
    if (items.TotalRecordCount > 0) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('jellyfin: library scan found no media after 120s')
}
