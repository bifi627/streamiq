// Gateway card edge cases on a paired browser (fixtures.ts `paired`).
import { expect, test } from './fixtures.ts'

test('a refused broker socket shows an error, not "loading…" (#403) @gateways', async ({
  paired,
}) => {
  const { page } = paired
  // A 429'd handshake (STREAMIQ_SIGNALING_PER_MINUTE) is invisible to JS: the
  // socket errors and closes without ever opening. Port 1 (Chrome blocks it)
  // does the same, without using up the shared per-IP budget.
  await page.addInitScript(() => {
    const Real = WebSocket
    window.WebSocket = class extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(
          String(url).endsWith('/broker/ws') ? 'ws://127.0.0.1:1/' : url,
          protocols,
        )
      }
    }
  })
  await page.reload() // drops the fixture's shared session
  const card = page.locator('li.card')
  const refused = /Couldn't reach StreamIQ: too many attempts or offline/

  await card.getByText('Paired clients', { exact: true }).click()
  await expect(card.getByRole('status')).toHaveText(refused)

  await card.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/g\/[^/]+$/) // left the card: not its note
  await expect(page.locator('[data-kind="broker-unreachable"]')).toContainText(
    refused,
  )
})
