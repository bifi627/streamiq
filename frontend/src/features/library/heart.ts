// The item page's heart: shown flipped at once, saved, put back on a failure.
import { toAppError } from '../../shared/errors.ts'
import type { Item } from './items.ts'

/** Movies, series and photos get a heart; episodes and folders don't. */
export const favorable = (i: Item) =>
  i.Type === 'Movie' || i.Type === 'Series' || i.Type === 'Photo'

/** Flips `was`: show() the new value, save() it, show() `was` again if the
 * save fails. Returns the error message, or '' once saved. */
export async function flipFavorite(
  was: boolean,
  show: (on: boolean) => void,
  save: (on: boolean) => Promise<unknown>,
): Promise<string> {
  show(!was)
  try {
    await save(!was)
    return ''
  } catch (e) {
    show(was)
    return toAppError(e).message
  }
}
