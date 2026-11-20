import { useQuery } from '@tanstack/react-query'
import { authed } from '../../api'
import { memberNames } from '../households/memberNames'

export type Member = { userId: string; name: string | null; email?: string }

/** Admin only: names by userId (undefined while loading) and the members but me. */
export function useMembers(admin: boolean, me: string | undefined) {
  const q = useQuery({
    queryKey: ['members'],
    queryFn: () => authed<Member[]>('/members'),
    enabled: admin,
  })
  return {
    names: q.data && memberNames(q.data),
    others: (q.data ?? []).filter((m) => m.userId !== me),
  }
}
