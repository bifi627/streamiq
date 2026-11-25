// The privacy badge's look per route. No imports beyond types, so node --test runs it.
import type { Route } from '../gateways/connection'

// Path icons, 24×24: each draws the route. A dot is a circle of radius 2.
const dot = (x: number, y: number) =>
  `M${x - 2} ${y}a2 2 0 1 0 4 0a2 2 0 1 0-4 0`
const ends = (y: number) => dot(4, y) + dot(20, y)
const forced = (tls: boolean) => ({
  label: 'Relayed · forced',
  // the relay path, pinned
  icon: ends(16) + 'M5.3 14.5 9 9.7M15 9.7l3.7 4.8M12 3v6M9 3h6M10 9h4',
  explain: `Force relay${tls ? ' over TLS (443)' : ''} is on in this browser, so the stream passes an encrypted relay that can't see it · turn it off in Diagnostics → Force relay (TURN)`,
})

/** The badge's label, icon path and explanation; relayed: the MB part or ''. */
export function look(route: Route, relayed: string) {
  switch (route) {
    case 'lan':
      return {
        label: 'On your network',
        // house with Wi-Fi
        icon: 'M3 11l9-7 9 7M5 10v10h14V10M9 15a4 4 0 0 1 6 0M11.99 18h.01',
        explain:
          'Straight from your gateway over your home network, end-to-end encrypted · never leaves the house',
      }
    case 'direct':
      return {
        label: 'Direct from home',
        icon: ends(12) + 'M6 12h12',
        explain:
          'Straight from your home to this device, end-to-end encrypted · StreamIQ carried 0 bytes',
      }
    case 'relay':
      return {
        label: 'Relayed · encrypted',
        // through a middle node
        icon: ends(16) + dot(12, 6) + 'M5.3 14.5 10.7 7.5M13.3 7.5l5.4 7',
        explain: `Your networks couldn't connect directly, so the stream passes an encrypted relay that can't see it${relayed}`,
      }
    case 'forced':
    case 'forcedTls': {
      const f = forced(route === 'forcedTls')
      return {
        ...f,
        explain: f.explain.replace(' · turn', `${relayed} · turn`),
      }
    }
  }
}
