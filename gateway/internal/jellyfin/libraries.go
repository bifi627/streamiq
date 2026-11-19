package jellyfin

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
)

// Libraries on a managed Jellyfin (#322): the local page shows each one's
// Offline and Extras state, read from Jellyfin every time, and changes a
// library only when its button is pressed. Nothing about libraries is stored.

// extras are the heavy local jobs StreamIQ doesn't use (trickplay, chapter images, LUFS).
var extras = []string{"EnableTrickplayImageExtraction", "ExtractTrickplayImagesDuringLibraryScan",
	"EnableChapterImageExtraction", "ExtractChapterImagesDuringLibraryScan", "EnableLUFSScan"}

// Library is one row of the local page's list.
type Library struct {
	ID, Name string
	Offline  bool   // every type the library can hold has every metadata and image fetcher off
	Extras   string // "On", "Off" or "Custom"
}

type folder struct {
	Name, ItemId, CollectionType string
	LibraryOptions               map[string]any
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
			out = append(out, Library{ID: f.ItemId, Name: f.Name, Offline: offline(f.LibraryOptions, types[f.CollectionType]),
				Extras: extrasState(f.LibraryOptions)})
		}
		return nil
	})
	return out, err
}

// MakeOffline turns every metadata and image fetcher of library id off, for
// every type it can hold. Other options stay as they are.
func (s *Setup) MakeOffline(ctx context.Context, id string) error {
	return s.editLibrary(ctx, id, func(admin string, f folder) error {
		types, err := s.itemTypes(ctx, admin, f.CollectionType)
		if err != nil {
			return err
		}
		tos, _ := f.LibraryOptions["TypeOptions"].([]any)
		for _, t := range types {
			m := typeOption(tos, t)
			if m == nil {
				m = map[string]any{"Type": t}
				tos = append(tos, m)
			}
			m["MetadataFetchers"], m["ImageFetchers"] = []string{}, []string{}
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

// itemTypes are the item types a library of contentType ("" = mixed) can hold.
func (s *Setup) itemTypes(ctx context.Context, admin, contentType string) ([]string, error) {
	var o struct{ TypeOptions []struct{ Type string } }
	q := "/Libraries/AvailableOptions?IsNewLibrary=false"
	if contentType != "" {
		q += "&LibraryContentType=" + url.QueryEscape(contentType)
	}
	if err := s.call(ctx, "GET", q, admin, "", &o); err != nil {
		return nil, err
	}
	var ts []string
	for _, t := range o.TypeOptions {
		ts = append(ts, t.Type)
	}
	return ts, nil
}

// asAdmin runs fn as the gateway's stored admin of a Jellyfin it set up, then
// signs out. Under vmu: a second sign-in as that admin would end this session.
func (s *Setup) asAdmin(ctx context.Context, fn func(admin string) error) error {
	s.vmu.Lock()
	defer s.vmu.Unlock()
	s.mu.Lock()
	c := s.creds
	s.mu.Unlock()
	if !c.managed() {
		return errors.New("only for a Jellyfin this gateway set up")
	}
	admin, err := s.signIn(ctx, c.User, c.Password)
	if err != nil {
		return err
	}
	defer s.logout(ctx, admin)
	return fn(admin)
}

// offline: every type has a TypeOptions entry with no fetcher enabled. A
// missing entry means every fetcher on (#314).
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
		return "Off"
	case len(extras):
		return "On"
	}
	return "Custom"
}
