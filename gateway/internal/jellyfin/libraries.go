package jellyfin

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"slices"
	"strconv"
)

// Libraries on a managed Jellyfin: the web gateway page shows each one's
// Offline, Extras and scan state, read from Jellyfin every time, and changes a
// library only when its button is pressed. Nothing about libraries is stored.

// extras are the heavy local jobs StreamIQ doesn't use (trickplay, chapter images, LUFS).
var extras = []string{"EnableTrickplayImageExtraction", "ExtractTrickplayImagesDuringLibraryScan",
	"EnableChapterImageExtraction", "ExtractChapterImagesDuringLibraryScan", "EnableLUFSScan"}

// errUserJellyfin: library calls are only for a Jellyfin the gateway set up.
var errUserJellyfin = errors.New("only for a Jellyfin this gateway set up")

// errRefused: Jellyfin refused the stored admin password; it isn't tried again until it changes.
var errRefused = errors.New("refused the gateway's admin password: " +
	"store the current one with gateway jellyfin login or on the local gateway page")

type folder struct {
	Name, ItemId, CollectionType string
	LibraryOptions               map[string]any
	RefreshProgress              *float64 // set while a scan of it runs
}

// Libraries lists the libraries of a Jellyfin the gateway set up.
func (s *Setup) Libraries(ctx context.Context) ([]Library, error) {
	var out []Library
	err := s.asAdmin(ctx, func(admin string) error {
		var fs []folder
		if err := s.call(ctx, "GET", "/Library/VirtualFolders", admin, "", &fs); err != nil {
			return err
		}
		types := map[string][]string{} // content type → item types it can hold
		for _, f := range fs {
			if _, ok := types[f.CollectionType]; !ok {
				t, err := s.itemTypes(ctx, admin, f.CollectionType)
				if err != nil {
					return err
				}
				types[f.CollectionType] = t
			}
			l := Library{ID: f.ItemId, Name: f.Name, Offline: offline(f.LibraryOptions, types[f.CollectionType]),
				Extras: extrasState(f.LibraryOptions), Scanning: f.RefreshProgress != nil}
			if l.Scanning {
				l.Progress = int(math.Round(*f.RefreshProgress))
			}
			out = append(out, l)
		}
		return nil
	})
	return out, err
}

// SetOnline sets the metadata and image fetchers of library id, for every
// type it can hold: off, every one; on, the ones Jellyfin enables for a new
// library. Other options stay as they are.
func (s *Setup) SetOnline(ctx context.Context, id string, on bool) error {
	return s.editLibrary(ctx, id, func(admin string, f folder) error {
		av, err := s.available(ctx, admin, f.CollectionType, true)
		if err != nil {
			return err
		}
		tos, _ := f.LibraryOptions["TypeOptions"].([]any)
		for _, t := range av {
			m := typeOption(tos, t.Type)
			if m == nil {
				m = map[string]any{"Type": t.Type}
				tos = append(tos, m)
			}
			m["MetadataFetchers"], m["ImageFetchers"] = enabled(t.MetadataFetchers, on), enabled(t.ImageFetchers, on)
		}
		f.LibraryOptions["TypeOptions"] = tos
		return nil
	})
}

// SetExtras turns all of library id's extras on or off.
func (s *Setup) SetExtras(ctx context.Context, id string, on bool) error {
	return s.editLibrary(ctx, id, func(_ string, f folder) error {
		for _, k := range extras {
			f.LibraryOptions[k] = on
		}
		return nil
	})
}

// Rescan starts Jellyfin's refresh of library id: new, changed and removed
// files, metadata only where it's missing (what the Dashboard's "Scan library"
// sends). It returns once Jellyfin has queued it.
func (s *Setup) Rescan(ctx context.Context, id string) error {
	return s.asAdmin(ctx, func(admin string) error {
		return s.call(ctx, "POST", "/Items/"+url.PathEscape(id)+"/Refresh?Recursive=true"+
			"&MetadataRefreshMode=Default&ImageRefreshMode=Default", admin, "", nil)
	})
}

// editLibrary round-trips library id's whole LibraryOptions through edit.
func (s *Setup) editLibrary(ctx context.Context, id string, edit func(admin string, f folder) error) error {
	return s.asAdmin(ctx, func(admin string) error {
		var fs []folder
		if err := s.call(ctx, "GET", "/Library/VirtualFolders", admin, "", &fs); err != nil {
			return err
		}
		i := slices.IndexFunc(fs, func(f folder) bool { return f.ItemId == id })
		if i < 0 || fs[i].LibraryOptions == nil {
			return errors.New("library not found (removed in Jellyfin?)")
		}
		if err := edit(admin, fs[i]); err != nil {
			return err
		}
		b, _ := json.Marshal(map[string]any{"Id": id, "LibraryOptions": fs[i].LibraryOptions})
		return s.call(ctx, "POST", "/Library/VirtualFolders/LibraryOptions", admin, string(b), nil)
	})
}

type fetcher struct {
	Name           string
	DefaultEnabled bool
}

// typeFetchers: an item type a library can hold, with the fetchers Jellyfin offers for it.
type typeFetchers struct {
	Type                            string
	MetadataFetchers, ImageFetchers []fetcher
}

// available: what Jellyfin offers a library of contentType ("" = mixed).
// DefaultEnabled is a new library's default only with isNew: else it is
// every fetcher the server-wide options don't disable.
func (s *Setup) available(ctx context.Context, admin, contentType string, isNew bool) ([]typeFetchers, error) {
	var o struct{ TypeOptions []typeFetchers }
	q := "/Libraries/AvailableOptions?IsNewLibrary=" + strconv.FormatBool(isNew)
	if contentType != "" {
		q += "&LibraryContentType=" + url.QueryEscape(contentType)
	}
	err := s.call(ctx, "GET", q, admin, "", &o)
	return o.TypeOptions, err
}

// itemTypes are the item types a library of contentType can hold.
func (s *Setup) itemTypes(ctx context.Context, admin, contentType string) ([]string, error) {
	av, err := s.available(ctx, admin, contentType, false)
	var ts []string
	for _, t := range av {
		ts = append(ts, t.Type)
	}
	return ts, err
}

// enabled: on, the fetchers Jellyfin enables by default; off, none. Never nil:
// a missing list reads as every fetcher on.
func enabled(fs []fetcher, on bool) []string {
	out := []string{}
	for _, f := range fs {
		if on && f.DefaultEnabled {
			out = append(out, f.Name)
		}
	}
	return out
}

// asAdmin runs fn as the gateway's stored admin of a Jellyfin it set up, then
// signs out. Under vmu: a second sign-in as that admin would end this session.
func (s *Setup) asAdmin(ctx context.Context, fn func(admin string) error) error {
	s.vmu.Lock()
	defer s.vmu.Unlock()
	s.mu.Lock()
	c, refused := s.creds, s.refused
	s.mu.Unlock()
	if !c.managed() {
		return errUserJellyfin
	}
	if refused { // no retry: Jellyfin locks users out after failed sign-ins
		return errRefused
	}
	admin, err := s.signIn(ctx, c.User, c.Password)
	if unauthorized(err) {
		s.mu.Lock()
		s.refused = s.creds.Password == c.Password
		s.mu.Unlock()
	}
	if err != nil {
		return err
	}
	defer s.logout(ctx, admin)
	return fn(admin)
}

// offline: every type has a TypeOptions entry with no fetcher enabled. A
// missing entry means every fetcher on.
func offline(opts map[string]any, types []string) bool {
	tos, _ := opts["TypeOptions"].([]any)
	for _, t := range types {
		m := typeOption(tos, t)
		if m == nil {
			return false
		}
		md, _ := m["MetadataFetchers"].([]any)
		img, _ := m["ImageFetchers"].([]any)
		if len(md)+len(img) > 0 {
			return false
		}
	}
	return true
}

func typeOption(tos []any, t string) map[string]any {
	for _, o := range tos {
		if m, _ := o.(map[string]any); m != nil && m["Type"] == t {
			return m
		}
	}
	return nil
}

func extrasState(opts map[string]any) string {
	n := 0
	for _, k := range extras {
		if opts[k] == true {
			n++
		}
	}
	switch n {
	case 0:
		return "off"
	case len(extras):
		return "on"
	}
	return "custom"
}
