// What the admin types to delete a household: its name, or for an unnamed one
// the id tag its label ends in ("Household …1a2b3c"), as "…" is hard to type.
export const confirmName = (m: { id: string; name: string | null }) =>
  m.name ?? m.id.slice(-6)

export const confirmed = (
  typed: string,
  m: { id: string; name: string | null },
) => typed.trim() === confirmName(m)
