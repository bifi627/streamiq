import type { Gateway } from './api'
import { gatewayName } from './list'
import { Pairing } from '../pairing/Pairing'
import { Dialog } from '../../shared/Dialog'

// Pair this browser with g in a dialog; pairing starts when it opens.
export function PairDialog({
  g,
  onClose,
  onPaired,
}: {
  g: Gateway
  onClose: () => void
  onPaired: () => void
}) {
  return (
    <Dialog title={`Pair with ${gatewayName(g)}`} onClose={onClose}>
      <Pairing
        gatewayId={g.id}
        lanUrl={g.lanUrl}
        autoPair
        onPaired={onPaired}
      />
    </Dialog>
  )
}
