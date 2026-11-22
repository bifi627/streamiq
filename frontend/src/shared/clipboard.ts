/** Copies text; false without the clipboard API (plain http, a LAN address, old
 *  TVs) or when it's blocked: the caller then lets the user select the text. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
