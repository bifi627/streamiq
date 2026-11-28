package tags

// The bodies of the tag endpoints (docs/protocol.md, "Tags"), types only:
// scripts/gen-types.sh makes the web app's TypeScript from this file.

// TagsPath is GET (every tag with its items); TagsPath/{itemId} PUT replaces one item's tags.
const TagsPath = "/streamiq/tags"

// MaxLen and MaxPerItem bound a PUT: a tag is 1–MaxLen characters after trimming,
// an item has at most MaxPerItem.
const (
	MaxLen     = 32
	MaxPerItem = 20
)

// Tag is a row of GET TagsPath: one tag and the Jellyfin items that carry it.
type Tag struct {
	Name    string   `json:"name"`
	ItemIDs []string `json:"itemIds"`
}

// SetTags is the body of PUT TagsPath/{itemId}; an empty list removes the item.
type SetTags struct {
	Tags []string `json:"tags"`
}
