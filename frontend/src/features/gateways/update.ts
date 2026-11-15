// A remote update the gateway card started (#312): the target it named and
// the version the gateway ran before.
export type Started = { to: string; from: string | null }

// Done once the list shows the gateway online on another version than before:
// the updater installs the latest release, maybe newer than `to`.
export const updated = (
  u: Started,
  g: { online: boolean; version: string | null },
) => g.online && g.version !== u.from
