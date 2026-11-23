import { createContext } from 'react'
import { useCanGoBack, useRouter } from '@tanstack/react-router'

/** The shell's title row parts that PageBar portals into. */
export type Slots = {
  back: HTMLElement | null
  title: HTMLElement | null
  actions: HTMLElement | null
}
export const SlotsContext = createContext<Slots | null>(null)

/** A page's Back: back in history; after a deep link (no in-app history)
 * `home` instead of leaving the app. */
export function useBack(home: () => void) {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  return () => (canGoBack ? router.history.back() : home())
}
