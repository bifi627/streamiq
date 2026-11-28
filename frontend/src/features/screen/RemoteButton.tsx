// Library's way back to a playing screen's remote: an accent icon in the
// title row while one plays; with several, a native picker of them.
import { useNavigate } from '@tanstack/react-router'
import { useTunnel } from '../library/art'
import { useOpenScreens } from '../library/queries'
import { tvOn } from '../../shared/settings'
import { playingScreens } from './remote'

export function RemoteButton() {
  const { gatewayId, pc } = useTunnel()
  const navigate = useNavigate()
  const tv = tvOn()
  const screens = useOpenScreens(gatewayId, pc, !tv) // shared with Play on…
  const playing = !tv && screens ? playingScreens(screens) : []
  if (!playing.length) return null
  const open = (screenId: string) =>
    navigate({
      to: '/g/$gatewayId/remote/$screenId',
      params: { gatewayId, screenId },
    })
  const icon = (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <circle cx="12" cy="8" r="2" />
      <path d="M10 14h4M10 17h4" />
    </svg>
  )
  if (playing.length === 1) {
    const label = `Remote: ${playing[0].name}`
    return (
      <button
        type="button"
        className="icon-btn remote-btn"
        aria-label={label}
        title={label}
        onClick={() => open(playing[0].id)}
      >
        {icon}
      </button>
    )
  }
  return (
    <span className="icon-btn remote-btn">
      {icon}
      <select
        aria-label="Remote"
        title="Remote"
        value=""
        onChange={(e) => open(e.target.value)}
      >
        <option value="" disabled>
          Remote
        </option>
        {playing.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </span>
  )
}
