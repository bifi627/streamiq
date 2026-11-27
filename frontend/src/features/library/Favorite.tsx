// The heart on a movie or series page: the viewer's own Jellyfin favorite
// (UserData.IsFavorite, saved through the already allowlisted UserData POST).
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { tunnelJson } from '../../shared/tunnel'
import { useTunnel } from './art'
import { flipFavorite } from './heart'
import type { Item } from './items'
import * as jf from './jellyfin'

export function Favorite({ item }: { item: Item }) {
  const { gatewayId, pc } = useTunnel()
  const qc = useQueryClient()
  const [on, setOn] = useState(!!item.UserData?.IsFavorite)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const click = async () => {
    setBusy(true)
    setMsg('')
    const save = (v: boolean) =>
      tunnelJson(pc, jf.userData(item.Id), { IsFavorite: v })
    setMsg(await flipFavorite(on, setOn, save))
    setBusy(false)
    for (const url of [jf.item(item.Id), jf.favorites])
      void qc.invalidateQueries({ queryKey: ['tunnel', gatewayId, url] })
  }
  return (
    <div className="favorite">
      <button
        type="button"
        aria-pressed={on}
        aria-disabled={busy}
        onClick={() => !busy && click()}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.2 0 3.8 1.2 5.3 3 1.5-1.8 3.1-3 5.3-3 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z" />
        </svg>
        Favorite
      </button>
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
    </div>
  )
}
