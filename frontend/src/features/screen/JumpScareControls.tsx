// The remote's jump scares: load a .srt, marks on the seek bar, the
// next-scare line. Parsing and storage: jumpscares.ts.
import { useRef, useState } from 'react'
import {
  jumpScareHint,
  parseJumpScares,
  saveJumpScares,
  type JumpScare,
} from './jumpscares.ts'

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
      {list.map((s) => (
        <i
          key={s.at}
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
    const found = parseJumpScares(await f.text())
    if (!found.length) return setMsg('No jump scares found in this file')
    setMsg(saveJumpScares(itemId, found) ? '' : "Couldn't save on this device")
    setList(found)
  }
  return (
    <div className="jumpscares">
      {list.length > 0 && (
        <p className="jumpscare-hint">{jumpScareHint(list, pos)}</p>
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
