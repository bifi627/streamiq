import { useState } from 'react'
import {
  compatibleOn,
  dataSaver,
  dataSaverOn,
  netInfo,
  rawOn,
  setCompatible,
  setDataSaver,
  setRaw,
} from '../../settings'
import { netReport } from './network'

// Settings' Playback card: compatible mode (#113), data saver (#291), Raw (#164).
export function Playback() {
  const [compatible, setOn] = useState(compatibleOn)
  const [raw, setRawOn] = useState(rawOn)
  const [saver, setSaver] = useState(dataSaver)
  return (
    <div className="card">
      <h2>Playback</h2>
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
            For old TVs: plays everything in the safest format, costs more work
            on your home PC.
          </p>
        </li>
        <li>
          {/* Buttons, not a select: a select keeps the D-pad's arrows
            (focus.ts), so focus could never leave it (#229). */}
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
  )
}
