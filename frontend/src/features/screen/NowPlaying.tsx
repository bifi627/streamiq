// The Now playing bar: from the gateway's pages back to a playing screen's remote.
import { Link, useMatches } from '@tanstack/react-router'
import * as jf from '../library/jellyfin'
import { primary, useTunnel, useTunnelQuery } from '../library/art'
import { Artwork } from '../library/Home'
import { useOpenScreens } from '../library/queries'
import type { Item } from '../library/items'
import type { Screen } from '../gateways/api'
import { tvOn } from '../../shared/settings'
import { nowPlayingOn, playingScreens } from './remote'

export function NowPlaying() {
  const { gatewayId, pc } = useTunnel()
  const matches = useMatches()
  const on = nowPlayingOn(matches[matches.length - 1]?.routeId, tvOn())
  const screens = useOpenScreens(gatewayId, pc, on) // shared with Play on…
  const playing = on && screens ? playingScreens(screens) : []
  if (!playing.length) return null
  return (
    <nav className="now-playing" aria-label="Now playing">
      {playing.map((s) => (
        <Entry key={s.id} gatewayId={gatewayId} screen={s} />
      ))}
    </nav>
  )
}

function Entry({ gatewayId, screen }: { gatewayId: string; screen: Screen }) {
  const item = useTunnelQuery<Item>(jf.item(screen.state?.itemId ?? '')).data
  return (
    <Link
      to="/g/$gatewayId/remote/$screenId"
      params={{ gatewayId, screenId: screen.id }}
    >
      <Artwork
        art={item ? primary(item) : null}
        card={item}
        width={96}
        className="now-playing-art"
      />
      <span>
        <b>{item?.Name}</b>
        <small className="muted">on {screen.name}</small>
      </span>
    </Link>
  )
}
