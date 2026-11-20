import { useState } from 'react'
import { arrowFocus } from './focus'
import { setTv, tvOn } from './settings'

/** The TV-mode checkbox, on the sign-in page and in Settings: both read the
 * stored value on mount, so a change in one shows in the other. */
export function TvToggle() {
  const [on, setOn] = useState(tvOn)
  return (
    <label className="setting">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setTv(e.target.checked)
          setOn(e.target.checked)
        }}
      />{' '}
      TV mode
    </label>
  )
}

/** First visit on a maybe-TV (settings.ts askTv): one question before
 * anything else; both answers are stored, so it never comes back. */
export function TvAsk({ done }: { done: () => void }) {
  const answer = (on: boolean) => {
    setTv(on)
    done()
  }
  return (
    <main className="signin" onKeyDown={arrowFocus}>
      <h1>Looks like a TV — use TV mode?</h1>
      <p className="muted">
        Larger text and a margin for TVs that crop the picture edges. You can
        change it later in Settings.
      </p>
      <button
        type="button"
        className="primary wide"
        autoFocus
        onClick={() => answer(true)}
      >
        Yes
      </button>
      <button type="button" className="wide" onClick={() => answer(false)}>
        No
      </button>
    </main>
  )
}
