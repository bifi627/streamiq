import { QueryClient } from '@tanstack/react-query'

// The one home of HTTP API state. In memory only: sign-out and a
// household switch reload the page, which empties it. No retry: a failed
// request shows its error at once.
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
})
