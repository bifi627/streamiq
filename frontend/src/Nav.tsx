import { Link } from '@tanstack/react-router'
import { arrowFocus } from './shared/focus'
import { TAB_TO, type Tab } from './shell'

// Inline SVG paths (24 × 24, stroked), no icon library.
const ICON: Record<Tab, string> = {
  gateways: 'M4 6h16v5H4zM4 13h16v5H4zM7 8.5h.01M7 15.5h.01',
  library: 'M8 5v14l11-7z',
  household: 'M3 11l9-7 9 7M5 10v10h14V10',
  settings:
    'M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1-2-4-2 1-2-1V5h-4v2l-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1v2h4v-2l2-1 2 1 2-4-2-1z',
}
const LABEL: Record<Tab, string> = {
  gateways: 'Gateways',
  library: 'Library',
  household: 'Household',
  settings: 'Settings',
}
// The main nav: in the top bar (desktop, TV), a bottom tab bar on a phone
// (index.css). Library is the main one; without a target it stays, disabled.
export function Nav({
  tabs,
  library,
}: {
  tabs: Tab[]
  library: string | null
}) {
  return (
    <nav className="nav" aria-label="Main" onKeyDown={arrowFocus}>
      {tabs.map((t) => {
        const inner = (
          <>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d={ICON[t]} />
            </svg>
            <span>{LABEL[t]}</span>
          </>
        )
        if (t !== 'library')
          return (
            <Link key={t} to={TAB_TO[t]}>
              {inner}
            </Link>
          )
        return library ? (
          <Link
            key={t}
            className="lib"
            to="/g/$gatewayId"
            params={{ gatewayId: library }}
          >
            {inner}
          </Link>
        ) : (
          <a key={t} className="lib" role="link" aria-disabled="true">
            {inner}
          </a>
        )
      })}
    </nav>
  )
}
