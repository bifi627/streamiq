// The item page's tags as chips; outside TV mode the viewer adds (suggesting the
// gateway's tags) and removes them. Decisions in tags.ts.
import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toAppError } from '../../shared/errors'
import { tvOn } from '../../shared/settings'
import { tunnelJson } from '../../shared/tunnel'
import { useTunnel, useTunnelQuery } from './art'
import type { Item } from './items'
import {
  TAGS,
  addTag,
  customTags,
  itemTagsUrl,
  removeTag,
  suggestions,
  type Tag,
} from './tags'

export function Tags({ item }: { item: Item }) {
  const { gatewayId, pc } = useTunnel()
  const qc = useQueryClient()
  const all = useTunnelQuery<Tag[]>(TAGS)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const have = customTags(all.data, all.error, item.Id)
  if (!have) return null
  const edit = !tvOn()
  if (!edit && !have.length) return null

  const save = async (tags: string[]) => {
    setBusy(true)
    setMsg('')
    try {
      await tunnelJson(pc, itemTagsUrl(item.Id), { tags }, 'PUT')
      setInput('')
      await qc.invalidateQueries({ queryKey: ['tunnel', gatewayId, TAGS] })
    } catch (e) {
      setMsg(toAppError(e).message)
    }
    setBusy(false)
  }
  const add = (e: FormEvent) => {
    e.preventDefault()
    const next = addTag(have, input, suggestions(all.data ?? [], []))
    if ('error' in next) return setMsg(next.error)
    if (next.tags.length === have.length) return setInput('')
    void save(next.tags)
  }

  return (
    <div className="tags">
      {!!have.length && (
        <ul aria-label="Tags">
          {have.map((t) => (
            <li key={t} className="chip">
              {t}
              {edit && (
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  aria-disabled={busy}
                  onClick={() => !busy && save(removeTag(have, t))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <form onSubmit={add}>
          <input
            aria-label="Add a tag"
            placeholder="Add a tag"
            list="tag-suggestions"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <datalist id="tag-suggestions">
            {suggestions(all.data ?? [], have).map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <button type="submit" aria-disabled={busy}>
            Add
          </button>
        </form>
      )}
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
    </div>
  )
}
