// The remote's jump scares: load a .srt, marks on the seek bar, the
// next-scare line. Parsing and storage: jumpscares.ts.
import { useRef, useState } from 'react'
import {
  jumpScareHint,
  importJumpScares,
  type JumpScare,
} from './jumpscares.ts'
import { clock } from '../library/items'

/** A tick per scare over the seek bar (its wrapper is position: relative). */
export function JumpScareMarks({
  list,
  dur,
}: {
  list: JumpScare[]
  dur: number
}) {
  if (!dur || !list.length) return null
  // ponytail: % of the track's full width; the thumb's inset puts a tick a few px off at the ends.
  return (
    <div className="jumpscare-marks" aria-hidden="true">
      {list.map((s, i) => (
        <i
          key={i}
          className={s.major ? 'major' : undefined}
          style={{ left: `${(Math.min(s.at, dur) / dur) * 100}%` }}
        />
      ))}
    </div>
  )
}

/** The hint and the file button. */
export function JumpScares({
  itemId,
  list,
  setList,
  pos,
}: {
  itemId: string
  list: JumpScare[]
  setList: (l: JumpScare[]) => void
  pos: number
}) {
  const file = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState('')
  const load = async (f: File | undefined) => {
    if (!f) return
    const r = importJumpScares(itemId, await f.text())
    setMsg(r.msg)
    if (r.list) setList(r.list)
  }
  return (
    <div className="jumpscares">
      {list.length > 0 && (
        <>
          <p className="jumpscare-hint">{jumpScareHint(list, pos)}</p>
          <details className="jumpscare-list">
            <summary>All jump scares ({list.length})</summary>
            <ol>
              {list.map((s, i) => (
                <li key={i} className={s.at <= pos ? 'passed' : undefined}>
                  {clock(s.at)} · {s.major ? 'major' : 'minor'}
                  {s.at <= pos && ' · passed'}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
      {msg && <small role="status">{msg}</small>}
      {/* no accept=".srt": iOS Safari greys out types it doesn't know */}
      <input
        ref={file}
        type="file"
        hidden
        aria-label="Jump scare file"
        onChange={(e) => {
          void load(e.target.files?.[0])
          e.target.value = '' // the same file again still fires change
        }}
      />
      <button
        type="button"
        className="secondary"
        onClick={() => file.current?.click()}
      >
        Jump scares
      </button>
    </div>
  )
}
