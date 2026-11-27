// Library home with its search field: a term (?q=, so Back returns to it)
// shows the current gateway's matches in place of the shelves (Home.tsx).
import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { PageBar } from '../../shared/PageBar'
import { ErrorView, State } from '../../shared/ErrorView'
import { toAppError } from '../../shared/errors'
import { PosterTile, Shelves } from './Home'
import { usePick, useTunnelQuery } from './art'
import type { Item } from './items'
import * as jf from './jellyfin'
import { fieldText, qSearch, resultLine, searchTerm, sections } from './search'

export function LibraryHome({ q }: { q?: string }) {
  const term = searchTerm(q)
  return (
    <>
      <PageBar title="Library" />
      <SearchField q={q ?? ''} />
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
function SearchField({ q }: { q: string }) {
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
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
  )
}

function Results({ term }: { term: string }) {
  const open = usePick()
  const q = useTunnelQuery<{ Items: Item[] }>(jf.search(term))
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
    <section className="home" aria-label="Search results">
      {sections(q.data.Items).map((s) => (
        <section key={s.title}>
          <h2>{s.title}</h2>
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
        </section>
      ))}
    </section>
  )
}
