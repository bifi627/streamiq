// hls.js loader that fetches every playlist, segment and subtitle through the
// tunnel (protocol.md: custom loader, not a Service Worker). hls.js resolves
// relative URLs against the master's, so the master lives under a sentinel
// origin that can never be fetched directly; the loader strips it back to an
// origin-relative path. Nothing can bypass the data channel.
import type {
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from 'hls.js'
import { tunnelFetch } from '../../tunnel'
import { rangeHeader } from './items'

export const TUNNEL_ORIGIN = 'https://gateway.tunnel'

const timing = () => ({ start: 0, first: 0, end: 0 })

export function tunnelLoader(pc: RTCPeerConnection) {
  return class TunnelLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null
    stats: LoaderStats = {
      aborted: false,
      loaded: 0,
      retry: 0,
      total: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: timing(),
      parsing: { start: 0, end: 0 },
      buffering: timing(),
    }
    private aborted = false
    private headers: Record<string, string> = {}

    destroy() {
      this.aborted = true
    }

    abort() {
      // ponytail: the in-flight channel still completes; its result is dropped.
      this.aborted = true
      this.stats.aborted = true
    }

    getResponseHeader(name: string) {
      const k = Object.keys(this.headers).find(
        (h) => h.toLowerCase() === name.toLowerCase(),
      )
      return k ? this.headers[k] : null
    }

    load(
      context: LoaderContext,
      _config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ) {
      this.context = context
      const s = this.stats
      s.loading.start = performance.now()
      const path = context.url.replace(/^https?:\/\/[^/]+/, '')
      const range = rangeHeader(context.rangeStart, context.rangeEnd)
      tunnelFetch(pc, path, { headers: range ? { Range: range } : {} }).then(
        (r) => {
          if (this.aborted) return
          this.headers = r.headers
          s.loading.first = s.loading.end = performance.now()
          s.loaded = s.total = r.body.byteLength
          s.chunkCount = 1
          if (r.status < 200 || r.status > 299)
            return callbacks.onError(
              { code: r.status, text: `HTTP ${r.status}` },
              context,
              null,
              s,
            )
          const data =
            context.responseType === 'arraybuffer'
              ? r.body.buffer
              : new TextDecoder().decode(r.body)
          callbacks.onSuccess({ url: context.url, data }, s, context, null)
        },
        (e: Error) => {
          if (!this.aborted)
            callbacks.onError({ code: 0, text: e.message }, context, null, s)
        },
      )
    }
  }
}
