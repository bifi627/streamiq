/** The one empty callback: for a slot that has nothing to do. A swallowed
 * error is not one: it writes event() from diag.ts instead. */
export const noop = () => {
  // nothing to do
}
