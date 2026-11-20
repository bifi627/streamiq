import { useEffect, useState } from 'react'
import { useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'
import { arrowFocus } from './focus'

/** TV mode's stand-in for a route a TV can't use (tvRoute.ts). */
export function Handoff({ url, home }: { url: string; home: string }) {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const navigate = useNavigate()
  const qr = useQrSvg(url)
  return (
    <section className="card join handoff" onKeyDown={arrowFocus}>
      <h1>Do this on your phone or PC</h1>
      <p className="muted">This page isn't available on a TV. Open:</p>
      {qr && (
        <div className="handoff-qr" dangerouslySetInnerHTML={{ __html: qr }} />
      )}
      <p className="handoff-url">{url}</p>
      <div className="actions">
        <button
          type="button"
          className="primary"
          autoFocus
          onClick={() =>
            canGoBack
              ? router.history.back()
              : navigate({ to: home, replace: true })
          }
        >
          Back
        </button>
      </div>
    </section>
  )
}

/** uqr's SVG of url, loaded on demand so the main bundle doesn't carry it; null until then or if loading fails. */
function useQrSvg(url: string) {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    import('uqr')
      .then(({ renderSVG }) => {
        // Fixed black on white with the spec's 4-module quiet zone: phone cameras need the contrast in either theme.
        const s = renderSVG(url, { border: 4 }).replace(
          '<svg ',
          `<svg role="img" aria-label="QR code of this page's address" `,
        )
        if (live) setSvg(s)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [url])
  return svg
}
