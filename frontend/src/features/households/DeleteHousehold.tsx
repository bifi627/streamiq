import { useState, type FormEvent } from 'react'
import { deleteHousehold } from '../../shared/api'
import { describe, toAppError } from '../../shared/errors'
import { Dialog } from '../../shared/Dialog'
import { householdLabel, switchHousehold } from './household'
import { confirmed, confirmName } from './confirmName'

// ⋮ → Delete: the admin types the household's name (confirmName) to confirm, then lands in their oldest other household or on the no-household
// screen. Other members' tabs follow on their next request (lostHousehold).
export function DeleteHousehold({
  household,
  onClose,
}: {
  household: { id: string; name: string | null }
  onClose: () => void
}) {
  const label = householdLabel(household)
  const [typed, setTyped] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await deleteHousehold()
      switchHousehold(null)
    } catch (x) {
      setErr(describe(toAppError(x)).message)
      setBusy(false)
    }
  }
  return (
    <Dialog title="Delete household" onClose={onClose}>
      <form onSubmit={submit}>
        <p>
          This deletes {label} for every member: its gateways, members and
          invites. It can't be undone. The gateways have to be added again to
          another household.
        </p>
        <label>
          Type {confirmName(household)} to confirm
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            autoComplete="off"
          />
        </label>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <button
          type="submit"
          className="primary wide"
          disabled={busy || !confirmed(typed, household)}
        >
          Delete household
        </button>
      </form>
    </Dialog>
  )
}
