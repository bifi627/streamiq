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
  type Change,
  type Tag,
} from './tags'

export function Tags({ item }: { item: Item }) {
  const { gatewayId, pc } = useTunnel()
  const qc = useQueryClient()
  const all = useTunnelQuery<Tag[]>(TAGS)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const have = customTags(all.data, item.Id)
  if (!have) return null
  const edit = !tvOn()
  if (!edit && !have.length) return null

  const key = ['tunnel', gatewayId, TAGS]
  // The PUT replaces the item's list: build it on the gateway's tags as they are
  // now, not on the cache another member's edit may have outdated.
  // ponytail: a last-write-wins window of one round trip; a per-item add/remove API if it bites.
  const save = async (change: (have: string[], all: Tag[]) => Change) => {
    setBusy(true)
    setMsg('')
    let saved = false
    try {
      const fresh = await qc.fetchQuery({
        queryKey: key,
        queryFn: () => tunnelJson<Tag[]>(pc, TAGS),
        staleTime: 0,
      })
      const next = change(customTags(fresh, item.Id) ?? [], fresh)
      if ('error' in next) setMsg(next.error)
      else {
        await tunnelJson(pc, itemTagsUrl(item.Id), { tags: next.tags }, 'PUT')
        saved = true
        await qc.invalidateQueries({ queryKey: key })
      }
    } catch (e) {
      setMsg(toAppError(e).message)
    }
    setBusy(false)
    return saved
  }
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const typed = input
    const change = (h: string[], a: Tag[]) =>
      addTag(h, typed, suggestions(a, []))
    if (await save(change)) setInput('')
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
                  onClick={() =>
                    !busy && save((h) => ({ tags: removeTag(h, t) }))
                  }
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
