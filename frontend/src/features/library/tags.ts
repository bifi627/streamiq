// The item page's tag decisions (TagChips.tsx): a tag is the gateway's, shared by
// everyone streaming from it (GET/PUT /streamiq/tags). In code `customTags`
// where Jellyfin's image `tag` is near (art.ts).
import { MaxLen, MaxPerItem, TagsPath, type Tag } from '../../generated/tags.ts'

export type { Tag }
export const TAGS = TagsPath

/** PUT URL of one item's tags. */
export const itemTagsUrl = (itemId: string) =>
  `${TAGS}/${encodeURIComponent(itemId)}`

/** The item's tags, by name; null hides the chips: no answer yet, or any error
 * (a gateway too old to keep tags answers 404). */
export function customTags(
  all: Tag[] | undefined,
  error: unknown,
  itemId: string,
): string[] | null {
  if (error || !all) return null
  return all.filter((t) => t.itemIds.includes(itemId)).map((t) => t.name)
}

/** The gateway's tags the item doesn't have yet: the add field's suggestions. */
export const suggestions = (all: Tag[], have: string[]) =>
  all.map((t) => t.name).filter((n) => !has(have, n))

const has = (list: string[], name: string) =>
  list.some((t) => t.toLowerCase() === name.toLowerCase())

/** `have` plus `input` (trimmed; an existing tag's spelling wins over the typed
 * one); unchanged for an empty input or one it already has; else why not. */
export function addTag(
  have: string[],
  input: string,
  existing: string[],
): { tags: string[] } | { error: string } {
  const typed = input.trim()
  if (!typed || has(have, typed)) return { tags: have }
  if ([...typed].length > MaxLen)
    return { error: `A tag is at most ${MaxLen} characters.` }
  if (have.length >= MaxPerItem)
    return { error: `At most ${MaxPerItem} tags per title.` }
  const name = existing.find((n) => has([n], typed)) ?? typed
  return { tags: [...have, name] }
}

export const removeTag = (have: string[], name: string) =>
  have.filter((t) => t !== name)
