import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { PageBar } from '../../shared/PageBar'
import { useBack } from '../../shared/slots'
import { arrowFocus } from '../../shared/focus'
import {
  compatibleOn,
  dataSaver,
  dataSaverOn,
  netInfo,
  rawOn,
  setCompatible,
  setDataSaver,
  setRaw,
  setSpeedEvery,
  speedEvery,
} from '../../shared/settings'
import { netReport } from './network'

// /settings/playback: compatible mode, data saver, measuring, Raw.
export function Playback() {
  const navigate = useNavigate()
  const back = useBack(() => navigate({ to: '/settings', replace: true }))
  const [compatible, setOn] = useState(compatibleOn)
  const [raw, setRawOn] = useState(rawOn)
  const [saver, setSaver] = useState(dataSaver)
  const [every, setEvery] = useState(speedEvery)
  return (
    <section className="settings" onKeyDown={arrowFocus}>
      <PageBar title="Playback" onBack={back} />
      <div className="head">
        <p className="muted">These apply to this device only.</p>
      </div>
      <div className="card">
        <ul className="rows">
          <li>
            <label className="setting">
              <input
                type="checkbox"
                autoFocus
                checked={compatible}
                onChange={(e) => {
                  setCompatible(e.target.checked)
                  setOn(e.target.checked)
                }}
              />{' '}
              Compatible mode
            </label>
            <p className="muted">
              For old TVs: plays everything in the safest format, costs more
              work on your home PC.
            </p>
          </li>
          <li>
            {/* Buttons, not a select: a select keeps the D-pad's arrows
            (focus.ts), so focus could never leave it. */}
            <div className="setting">
              <span id="saver">Data saver</span>
              <div role="group" aria-labelledby="saver" className="choice">
                {(
                  [
                    ['auto', 'Automatic'],
                    ['on', 'On'],
                    ['off', 'Off'],
                  ] as const
                ).map(([v, name]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={saver === v}
                    onClick={() => {
                      setDataSaver(v)
                      setSaver(v)
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted">
              {dataSaverOn() ? 'On now' : 'Off now'}: Auto quality stays at 480p
              and the speed test uses ~3 MB instead of up to ~50 MB. Automatic
              turns it on on mobile data or when the browser asks to save data.
              This browser reports: {netReport(netInfo())}.
            </p>
          </li>
          <li>
            <div className="setting">
              <span id="speed">Measure connection speed</span>
              <div role="group" aria-labelledby="speed" className="choice">
                {(
                  [
                    ['30m', 'Every 30 min'],
                    ['2h', 'Every 2 h'],
                    ['1d', 'Every day'],
                    ['off', 'Off'],
                  ] as const
                ).map(([v, name]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={every === v}
                    onClick={() => {
                      setSpeedEvery(v)
                      setEvery(v)
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted">
              Auto quality measures the speed to your home PC when a video
              starts, at most this often per connection. Off: it uses the last
              result, or no limit.
            </p>
          </li>
          <li>
            <label className="setting">
              <input
                type="checkbox"
                checked={raw}
                onChange={(e) => {
                  setRaw(e.target.checked)
                  setRawOn(e.target.checked)
                }}
              />{' '}
              Raw quality option
            </label>
            <p className="muted">
              Adds Raw to the player's quality menu: plays original streams with
              no check of what this device can decode, so they may not play.
            </p>
          </li>
        </ul>
      </div>
    </section>
  )
}
