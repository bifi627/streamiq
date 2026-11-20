type Named = { userId: string; name: string | null; email?: string }

const base = (m: Named) => (m.name || m.email || 'unknown user').trim()

// Aliases are free text and can't be made unique (they live in Firebase), so
// members who show the same name get the shortest userId suffix (≥ 4 hex chars;
// ids are sequential, so the prefix is a timestamp shared by recent sign-ups)
// that tells them apart: "Alex #a3f9". Keyed by userId.
export function memberNames(members: Named[]): Map<string, string> {
  const groups = new Map<string, Named[]>()
  for (const m of members) {
    const key = base(m).toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), m])
  }
  const out = new Map<string, string>()
  for (const group of groups.values()) {
    const ids = group.map((m) => m.userId.replace(/-/g, ''))
    const distinct = (n: number) =>
      new Set(ids.map((id) => id.slice(-n))).size === ids.length
    let n = 4
    while (!distinct(n) && n < 32) n++
    group.forEach((m, i) =>
      out.set(
        m.userId,
        group.length > 1 ? `${base(m)} #${ids[i].slice(-n)}` : base(m),
      ),
    )
  }
  return out
}
