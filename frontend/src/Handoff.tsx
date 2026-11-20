import { useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'
import { arrowFocus } from './focus'

/** TV mode's stand-in for a route a TV can't use (tvRoute.ts). */
export function Handoff({ url, home }: { url: string; home: string }) {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const navigate = useNavigate()
  return (
    <section className="card join handoff" onKeyDown={arrowFocus}>
      <h1>Do this on your phone or PC</h1>
      <p className="muted">This page isn't available on a TV. Open:</p>
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
