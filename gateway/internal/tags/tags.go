// Package tags keeps the gateway's tags: words a household puts on Jellyfin items,
// shared by everyone who streams from this gateway, stored in its state dir only
// (never in Jellyfin or the media).
package tags

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	"streamiq/gateway/internal/tunnel"
)

// File is the store's name in the state dir: Jellyfin item id → its tags.
const File = "tags.json"

var itemID = regexp.MustCompile(`^` + tunnel.JellyfinID + `$`)

// Store is tags.json behind one mutex. ponytail: the whole map rewritten per PUT;
// fine for thousands of items, an append log if it ever isn't.
type Store struct {
	mu   sync.Mutex
	path string
	m    map[string][]string
}

// Load reads dir's tags.json; none yet is an empty store.
func Load(dir string) (*Store, error) {
	s := &Store{path: filepath.Join(dir, File), m: map[string][]string{}}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	} else if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s.m); err != nil {
		return nil, fmt.Errorf("tags: %s: %w", s.path, err)
	}
	if s.m == nil { // the file says null
		s.m = map[string][]string{}
	}
	return s, nil
}

// ServeList is GET TagsPath: every tag with its item ids, by name (case-insensitively).
func (s *Store) ServeList(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	by := map[string][]string{}
	for id, ts := range s.m {
		for _, t := range ts {
			by[t] = append(by[t], id)
		}
	}
	s.mu.Unlock()
	out := []Tag{}
	for name, ids := range by {
		slices.Sort(ids)
		out = append(out, Tag{Name: name, ItemIDs: ids})
	}
	slices.SortFunc(out, func(a, b Tag) int {
		lower := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
		return cmp.Or(lower, strings.Compare(a.Name, b.Name))
	})
	tunnel.JSON(w, http.StatusOK, out)
}

// ServeSet is PUT TagsPath/{itemId}: replaces the item's tags (clean's rules); 204.
func (s *Store) ServeSet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("itemId")
	var b SetTags
	if !itemID.MatchString(id) ||
		json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&b) != nil || b.Tags == nil {
		tunnel.Fail(w, http.StatusBadRequest, errors.New("tags: bad item id or body"))
		return
	}
	ts, err := clean(b.Tags)
	if err != nil {
		tunnel.Fail(w, http.StatusBadRequest, err)
		return
	}
	if err := s.set(id, ts); err != nil {
		tunnel.Fail(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// clean trims each tag and merges case-insensitive duplicates (the first spelling
// stays); a tag outside 1–MaxLen characters or more than MaxPerItem is an error.
func clean(in []string) ([]string, error) {
	out := []string{}
	for _, t := range in {
		t = strings.TrimSpace(t)
		if n := utf8.RuneCountInString(t); n < 1 || n > MaxLen {
			return nil, fmt.Errorf("tags: a tag is 1-%d characters, not %q", MaxLen, t)
		}
		if !slices.ContainsFunc(out, func(o string) bool { return strings.EqualFold(o, t) }) {
			out = append(out, t)
		}
	}
	if len(out) > MaxPerItem {
		return nil, fmt.Errorf("tags: at most %d per item", MaxPerItem)
	}
	return out, nil
}

// set stores ts for id (none removes it); a failed save changes nothing.
func (s *Store) set(id string, ts []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := maps.Clone(s.m)
	if len(ts) == 0 {
		delete(m, id)
	} else {
		m[id] = ts
	}
	if err := save(s.path, m); err != nil {
		return err
	}
	s.m = m
	return nil
}

// save writes a temp file and renames it over path: a crash leaves the old file
// or the new one, never half of one.
func save(path string, m map[string][]string) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
