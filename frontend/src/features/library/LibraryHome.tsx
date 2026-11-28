// Library home with its search field: a term (?q=, so Back returns to it)
// shows the current gateway's matches in place of the shelves (Home.tsx).
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { PageBar } from '../../shared/PageBar'
import { Chevron } from '../../shared/Chevron'
import { ErrorView, State } from '../../shared/ErrorView'
import { toAppError } from '../../shared/errors'
import { PosterTile, Shelves } from './Home'
import { usePick, useTunnel, useTunnelQuery } from './art'
import type { Item } from './items'
import * as jf from './jellyfin'
import { RemoteButton } from '../screen/RemoteButton'
import { fieldText, qSearch, resultLine, searchTerm, sections } from './search'

export function LibraryHome({ q }: { q?: string }) {
  const navigate = useNavigate()
  const { gatewayId } = useTunnel()
  const term = searchTerm(q)
  const [open, setOpen] = useState(!!q)
  const [seen, setSeen] = useState(q)
  if (q !== seen) {
    setSeen(q)
    if (q) setOpen(true) // Back to a search; not the old q while closing
  }
  const toggle = () => {
    if (open) void navigate({ to: '.', search: {}, replace: true })
    setOpen(!open)
  }
  return (
    <>
      <PageBar
        title="Library"
        actions={
          <>
            <RemoteButton />
            <button
              type="button"
              className="icon-btn"
              aria-label="Watch history"
              title="Watch history"
              onClick={() =>
                navigate({ to: '/g/$gatewayId/history', params: { gatewayId } })
              }
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="8" />
                <path d="M12 8v4l3 2" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Search"
              title="Search"
              aria-expanded={open}
              onClick={toggle}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-4-4" />
              </svg>
            </button>
          </>
        }
      />
      {/* Opened by the button: it takes focus. With a ?q=, the results' first
          card does (Results). */}
      {open && <SearchField q={q ?? ''} autoFocus={!q} />}
      {term && <Results term={term} />}
      {/* Stays mounted while searching: a remount would autofocus a card,
          taking focus from the field. */}
      <div hidden={!!term}>
        <Shelves />
      </div>
    </>
  )
}

/** Typing settles into ?q= after a pause, replacing the history entry. */
function SearchField({ q, autoFocus }: { q: string; autoFocus: boolean }) {
  const navigate = useNavigate()
  const [text, setText] = useState(q)
  const [pushed, setPushed] = useState(q) // the last term this field put in the URL
  const [seen, setSeen] = useState(q)
  if (q !== seen) {
    setSeen(q)
    setText(fieldText(text, q, pushed))
  }
  useEffect(() => {
    if (text === q) return
    const t = setTimeout(() => {
      setPushed(text)
      void navigate({ to: '.', search: qSearch(text), replace: true })
    }, 300)
    return () => clearTimeout(t)
  }, [text, q, navigate])
  return (
    <input
      type="search"
      className="search"
      placeholder="Search movies and shows"
      aria-label="Search"
      enterKeyHint="search"
      autoFocus={autoFocus}
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
  )
}

function Results({ term }: { term: string }) {
  const open = usePick()
  const q = useTunnelQuery<{ Items: Item[] }>(jf.search(term))
  const box = useRef<HTMLElement>(null)
  // Back from a result or a ?q= link: nothing has focus (after the commit,
  // the page left has let go), so the D-pad starts on the first result.
  // While typing, the field keeps it.
  useEffect(() => {
    if (document.activeElement === document.body)
      box.current?.querySelector('button')?.focus()
  }, [q.data])
  if (q.error) return <ErrorView error={toAppError(q.error)} />
  if (!q.data)
    return (
      <ul className="poster-grid" role="status" aria-label="Loading">
        {[0, 1, 2, 3].map((n) => (
          <li key={n}>
            <div className="ph poster" />
            <div className="ph ph-line" />
          </li>
        ))}
      </ul>
    )
  if (!q.data.Items.length)
    return <State icon="empty" title={`Nothing found for “${term}”.`} />
  return (
    <section ref={box} className="home" aria-label="Search results">
      {sections(q.data.Items).map((s) => (
        <details key={s.title} className="result-section" open>
          <summary>
            <h2>{s.title}</h2>
            <Chevron />
          </summary>
          <ul className="poster-grid" aria-label={s.title}>
            {s.items.map((i) => (
              <PosterTile
                key={i.Id}
                item={i}
                line={resultLine(i)}
                onOpen={open}
              />
            ))}
          </ul>
        </details>
      ))}
    </section>
  )
}
