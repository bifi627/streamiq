import { useEffect, useRef, useState } from 'react'
import {
  listClients,
  removeClient,
  renameClient,
  type Client,
  type Gateway,
} from './api'
import { toAppError } from '../../shared/errors'
import { EditableName } from './EditableName'
import {
  clientRenameMessage,
  clientsMessage,
  clientsNote,
  profileLine,
  removeOutcome,
} from './list'

// The gateway's paired clients (a member sees only its own) over the shared tunnel
// session, loaded each time the section opens. Removing one ends its sessions;
// removing this browser closes the tunnel, and the card offers Pair again.
export function PairedClients({
  g,
  unpaired,
  onRemovedSelf,
}: {
  g: Gateway
  unpaired: boolean
  onRemovedSelf: () => void
}) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Client[] | null>(null)
  const [msg, setMsg] = useState<string | null>(null) // the load's error
  const [actMsg, setActMsg] = useState<string | null>(null) // a Remove's
  const summary = useRef<HTMLElement>(null)
  const live = open && g.online && !unpaired
  useEffect(() => {
    if (!live) return
    let on = true
    listClients(g.id)
      .then((l) => {
        if (!on) return
        setList(l)
        setMsg(null)
        setActMsg(null)
      })
      .catch((x) => {
        if (on) setMsg(clientsMessage(toAppError(x)))
      })
    return () => {
      on = false
    }
  }, [live, g.id])
  const note = clientsNote({
    online: g.online,
    unpaired,
    msg: msg ?? actMsg,
    loaded: list !== null,
  })
  const shown = g.online && !unpaired ? list : null

  // null = renamed; else the error to show in the form.
  async function rename(c: Client, name: string) {
    try {
      const stored = await renameClient(g.id, c.keyFp, name)
      setList(
        (l) =>
          l && l.map((x) => (x.keyFp === c.keyFp ? { ...x, name: stored } : x)),
      )
      setActMsg(null) // a failed Remove's line is stale now
      return null
    } catch (x) {
      return clientRenameMessage(toAppError(x))
    }
  }

  async function remove(c: Client) {
    if (
      !confirm(
        c.self
          ? 'Remove this browser? It must pair again to use this gateway.'
          : `Remove "${c.name}"? Its streams stop and it must pair again.`,
      )
    )
      return
    let err = null
    try {
      await removeClient(g.id, c.keyFp)
    } catch (x) {
      err = toAppError(x)
    }
    const o = removeOutcome(err, c.self)
    setActMsg(o.msg)
    if (!o.done) return
    if (o.done === 'self') onRemovedSelf()
    if (o.done === 'row')
      setList((l) => l && l.filter((x) => x.keyFp !== c.keyFp))
    // The focused Remove is gone: keep the D-pad's place, as Rename does.
    summary.current?.focus()
  }

  return (
    <details className="no-tv" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary ref={summary}>Paired clients</summary>
      {note && <p role="status">{note}</p>}
      {shown?.length === 0 && <p>No paired clients.</p>}
      {!!shown?.length && (
        <ul className="clients">
          {shown.map((c) => (
            <li key={c.keyFp}>
              <EditableName
                name={c.name}
                label="Client name"
                rename={(n) => rename(c, n)}
              >
                <span>
                  {c.name}
                  {c.self && <b> (this browser)</b>} · paired{' '}
                  {new Date(c.addedAt).toLocaleDateString()}
                </span>
              </EditableName>
              <button type="button" className="link" onClick={() => remove(c)}>
                Remove
              </button>
              <small className="profile">{profileLine(c.profile)}</small>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
