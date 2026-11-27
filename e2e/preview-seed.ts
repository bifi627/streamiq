// What `npm run preview` seeds: households, users, the open invite and the extra
// media, as one config; preview.ts applies it the same way on every `up`.
import os from 'node:os'
import path from 'node:path'

type Role = 'admin' | 'member'

export const seed = {
  email: (user: string) => `${user}@streamiq.test`,
  password: 'preview-password',
  // user → alias (Firebase displayName: no alias prompt). preview = the main login.
  users: {
    preview: 'Preview',
    mara: 'Mara',
    jonas: 'Jonas',
    lea: 'Lea',
    sam: 'Sam',
    noor: 'Noor',
  },
  // The first member creates the household (its admin), the rest join by invite.
  // preview's first household is the one it opens in: the one with the gateway.
  households: [
    {
      name: 'Preview Home',
      gateway: true,
      openInvite: true,
      members: {
        preview: 'admin',
        mara: 'admin',
        jonas: 'member',
        lea: 'member',
      },
    },
    {
      name: 'Mara and Sam',
      members: { mara: 'admin', preview: 'member', sam: 'member' },
    },
    {
      name: 'Noor’s Cabin',
      members: {
        noor: 'admin',
        sam: 'admin',
        preview: 'member',
        lea: 'member',
      },
    },
  ] as {
    name: string
    gateway?: boolean
    openInvite?: boolean
    members: Record<string, Role>
  }[],
  // Invented titles (no real ones; no internet metadata anyway). Minutes, a lavfi
  // video source, a hue shift: every title gets a poster and picture of its own.
  movies: [
    ['Neon Harbor', 2026, 12, 'testsrc2', 0],
    ['The Last Orbit', 2025, 9, 'gradients', 40],
    ['Glass Kingdom', 2026, 7, 'smptehdbars', 0],
    ['Midnight Protocol', 2024, 11, 'pal75bars', 0],
    ['Saltwater Saints', 2025, 5, 'rgbtestsrc', 120],
    ['Echoes of Arden', 2026, 8, 'cellauto', 0],
    ['Iron Meridian', 2023, 10, 'testsrc', 200],
    ['The Quiet Signal', 2025, 6, 'gradients', 160],
    ['Paper Crowns', 2024, 4, 'yuvtestsrc', 0],
    ['Wildfire Season', 2026, 9, 'testsrc2', 300],
    ['Solar Drift', 2025, 3, 'gradients', 260],
    ['Hollow Tides', 2024, 6, 'color=c=darkslateblue', 90],
    ['Northbound', 2026, 5, 'smptehdbars', 180],
    ['Ghost Frequency', 2025, 8, 'cellauto', 220],
    ['Crimson Ledger', 2023, 7, 'testsrc', 0],
    ['Atlas Falling', 2026, 10, 'rgbtestsrc', 0],
    ['Little Thunder', 2024, 2, 'yuvtestsrc', 140],
    ['Tidebreaker', 2025, 6, 'testsrc2', 100],
    ['Velvet Static', 2026, 4, 'gradients', 320],
    ['Borrowed Summer', 2024, 5, 'testsrc', 60],
    ['Deep Field', 2025, 11, 'smptebars', 200],
    ['Cold Open', 2023, 3, 'smptehdbars', 90],
    ['Starlight Motel', 2026, 7, 'cellauto', 300],
    ['Second Sunrise', 2025, 6, 'rgbtestsrc', 240],
    ['Lantern Bay', 2024, 8, 'yuvtestsrc', 30],
  ] as [string, number, number, string, number][],
  // Title, year, episodes per season (minutes each), source, hue.
  series: [
    ['Starfall Academy', 2025, [6], 2, 'testsrc2', 210],
    ['The Overlook Files', 2024, [3, 3, 3], 3, 'gradients', 0],
    ['Harbor Lights', 2026, [4, 2], 1, 'cellauto', 120],
  ] as [string, number, number[], number, string, number][],
  // Photo albums (folders, `/` = a sub-folder): file, size, source, hue. One
  // large (4096 wide) and one PNG, for #1018's resizing and formats.
  photos: {
    'Summer Coast': [
      ['Beach.jpg', '1920x1280', 'gradients', 20],
      ['Lighthouse.jpg', '1080x1440', 'testsrc2', 200],
      ['Panorama.jpg', '4096x2048', 'gradients', 180],
      ['Sunset.jpg', '1600x1200', 'gradients', 300],
    ],
    'Mountain Weekend': [
      ['Ridge.jpg', '1920x1080', 'smptehdbars', 90],
      ['Cabin.jpg', '1200x1600', 'cellauto', 0],
    ],
    'Mountain Weekend/Day 2': [
      ['Summit.jpg', '2048x1365', 'testsrc', 140],
      ['Trail.jpg', '900x1600', 'rgbtestsrc', 60],
    ],
    Garden: [
      ['Tulips.jpg', '1440x1080', 'yuvtestsrc', 320],
      ['Fern.png', '1024x1024', 'cellauto', 120],
      ['Bench.jpg', '1080x1350', 'pal75bars', 240],
    ],
  } as Record<string, [string, string, string, number][]>,
}

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' // in the Jellyfin image
const FFMPEG = '/usr/lib/jellyfin-ffmpeg/ffmpeg -loglevel error -y'

// A source at the given size with the title on it (plain words: no drawtext escaping).
const picture = (
  src: string,
  hue: number,
  size: string,
  title: string,
  font: number,
) =>
  `-f lavfi -i "${src}${src.includes('=') ? ':' : '='}size=${size}:rate=10,hue=h=${hue},` +
  `drawtext=fontfile=${FONT}:text='${title}':fontsize=${font}:fontcolor=white:` +
  `box=1:boxcolor=black@0.6:boxborderw=12:x=(w-tw)/2:y=h*0.7"`

const video = (
  src: string,
  hue: number,
  title: string,
  mins: number,
  out: string,
) =>
  `${FFMPEG} ${picture(src, hue, '640x360', title, 28)} -f lavfi -i sine=frequency=330 ` +
  `-t ${mins * 60} -c:v libx264 -preset ultrafast -crf 40 -pix_fmt yuv420p -c:a aac -b:a 32k "${out}"`

const still = (
  src: string,
  hue: number,
  size: string,
  title: string,
  font: number,
  out: string,
) =>
  // bitexact: no "Lavc…" JPEG comment, which Jellyfin shows as a photo's overview.
  `${FFMPEG} ${picture(src, hue, size, title, font)} -frames:v 1 -flags:v +bitexact "${out}"`

const poster = (src: string, hue: number, title: string, out: string) =>
  still(src, hue, '400x600', title, 30, out)

// Locked local title and year: without them Jellyfin names a film after its folder,
// year included ("Neon Harbor (2026) (2026)"). Online metadata: none, the jail.
const nfo = (kind: string, title: string, year: number, out: string) =>
  `printf '<?xml version="1.0"?><${kind}><title>${title}</title><year>${year}</year>` +
  `<lockdata>true</lockdata></${kind}>' > "${out}"`

// One sh script for the pinned Jellyfin image: Jellyfin's Movies (folder per film,
// poster.jpg beside it), Series/Season NN/SxxEyy and photo album layouts under /out.
export const script = [
  ...seed.movies.map(([title, year, mins, src, hue]) => {
    const d = `/out/movies/${title} (${year})`
    return `mkdir -p "${d}" && ${nfo('movie', title, year, `${d}/movie.nfo`)} && ${poster(src, hue, title, `${d}/poster.jpg`)} && ${video(src, hue, title, mins, `${d}/${title} (${year}).mp4`)}`
  }),
  ...seed.series.flatMap(([title, year, seasons, mins, src, hue]) => {
    const d = `/out/shows/${title} (${year})`
    return [
      `mkdir -p "${d}" && ${nfo('tvshow', title, year, `${d}/tvshow.nfo`)} && ${poster(src, hue, title, `${d}/poster.jpg`)}`,
      ...seasons.flatMap((eps, s) =>
        Array.from({ length: eps }, (_, e) => {
          const se = `S${String(s + 1).padStart(2, '0')}E${String(e + 1).padStart(2, '0')}`
          const sd = `${d}/Season ${String(s + 1).padStart(2, '0')}`
          return `mkdir -p "${sd}" && ${video(src, (hue + 30 * e) % 360, `${title} ${se}`, mins, `${sd}/${title} ${se}.mp4`)}`
        }),
      ),
    ]
  }),
  ...Object.entries(seed.photos).flatMap(([album, photos]) => {
    const d = `/out/photos/${album}`
    return photos.map(
      ([file, size, src, hue]) =>
        `mkdir -p "${d}" && ${still(src, hue, size, file.replace(/\.\w+$/, ''), Math.round(Number(size.split('x')[1]) / 16), `${d}/${file}`)}`,
    )
  }),
].join(' && ')

/** The extra media, encoded once per machine: a cache all worktrees share. */
// stack.ts loads lazily, as in preview.ts: up/status/down don't need testcontainers.
export const media = async () =>
  (await import('./stack.ts')).encodeOnce(
    path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache'),
      'streamiq',
    ),
    'preview-media',
    script,
  )

/** Applies `seed` through the API, as real users: returns the gateway
 * household's admin (preview) calls, scoped to that household. */
export async function apply(api: string, emulator: string) {
  const calls: Record<
    string,
    (
      p: string,
      method?: string,
      body?: object,
      household?: string,
    ) => Promise<any>
  > = {}
  const idp = (op: string, body: object, admin = false) =>
    fetch(
      `${emulator}/identitytoolkit.googleapis.com/v1/accounts:${op}?key=demo-key`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(admin && { Authorization: 'Bearer owner' }),
        },
        body: JSON.stringify(body),
      },
    ).then((r) => r.json())
  for (const [user, alias] of Object.entries(seed.users)) {
    const login = { email: seed.email(user), password: seed.password }
    // A fixed UID (only the emulator's admin may set one): the emulator's
    // refresh token names just the UID, so a browser signed in to an earlier
    // preview run stays signed in.
    const made = await idp(
      'signUp',
      { ...login, localId: `preview-${user}`, displayName: alias },
      true,
    )
    if (!made.localId)
      throw new Error(`emulator signUp: ${JSON.stringify(made)}`)
    const r = await idp('signInWithPassword', {
      ...login,
      returnSecureToken: true,
    })
    if (!r.idToken) throw new Error(`emulator sign-in: ${JSON.stringify(r)}`)
    calls[user] = async (p, method = 'GET', body, household) => {
      const res = await fetch(`${api}/api${p}`, {
        method,
        headers: {
          Authorization: `Bearer ${r.idToken}`,
          'Content-Type': 'application/json',
          ...(household && { 'X-StreamIQ-Household': household }),
        },
        body: body && JSON.stringify(body),
      })
      if (!res.ok)
        throw new Error(`${user}: ${method} /api${p}: HTTP ${res.status}`)
      const text = await res.text()
      return text ? JSON.parse(text) : null
    }
  }
  let home: ((p: string, method?: string) => Promise<any>) | undefined
  for (const h of seed.households) {
    const [owner, ...rest] = Object.entries(h.members)
    const as = calls[owner[0]]
    const { householdId: id } = await as('/households', 'POST')
    await as('/households/current/name', 'PUT', { name: h.name }, id)
    for (const [user, role] of rest) {
      const { token } = await as('/invites', 'POST', undefined, id)
      await calls[user]('/invites/accept', 'POST', { token })
      if (role === 'admin') {
        const { userId } = await calls[user]('/me')
        await as(`/members/${userId}/role`, 'PUT', { role }, id)
      }
    }
    if (h.openInvite) await as('/invites', 'POST', undefined, id)
    if (h.gateway) home = (p, method) => as(p, method, undefined, id)
  }
  if (!home) throw new Error('preview seed: no household with gateway: true')
  return home
}

/** One line per seeded sign-in, for up/status. */
export const signIns = () =>
  Object.entries(seed.users).map(([user, alias]) => {
    const roles = seed.households
      .filter((h) => user in h.members)
      .map((h) => `${h.name} (${h.members[user]})`)
      .join(', ')
    return `${seed.email(user)} / ${seed.password}  ${alias}: ${roles}`
  })
