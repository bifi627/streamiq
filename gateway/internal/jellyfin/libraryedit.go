package jellyfin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"slices"
	"strings"
)

// Libraries made and changed from the web app: only from folders the
// managed Jellyfin sees under mediaRoot, always created offline. Jellyfin
// addresses a library by name, the web app by id. No file is ever deleted.

// mediaRoot is where jellyfin-compose.yml mounts the host's media folders.
const mediaRoot = "/media"

// badRequest is a library call the gateway refuses: 400, the web app shows it.
type badRequest string

func (e badRequest) Error() string { return string(e) }

// mediaFolder is p cleaned, if that is a folder right under mediaRoot. Never a
// string prefix of the raw input: /media/../etc cleans to /etc.
func mediaFolder(p string) (string, error) {
	c := path.Clean(p)
	if path.Dir(c) != mediaRoot {
		return "", badRequest(fmt.Sprintf("%q is not a folder in %s.", p, mediaRoot))
	}
	return c, nil
}

// MediaFolders lists the folders Jellyfin sees right under mediaRoot, each
// with the libraries using it.
func (s *Setup) MediaFolders(ctx context.Context) ([]MediaFolder, error) {
	out := []MediaFolder{}
	err := s.asAdmin(ctx, func(admin string) error {
		fs, err := s.folders(ctx, admin)
		if err != nil {
			return err
		}
		var dirs []struct{ Path string }
		if err := s.call(ctx, "GET", "/Environment/DirectoryContents?path="+url.QueryEscape(mediaRoot)+
			"&includeDirectories=true&includeFiles=false", admin, "", &dirs); err != nil {
			return err
		}
		for _, d := range dirs {
			if p, err := mediaFolder(d.Path); err != nil || p != d.Path {
				continue
			}
			out = append(out, MediaFolder{Path: d.Path, Libraries: usedBy(fs, d.Path)})
		}
		return nil
	})
	return out, err
}

// usedBy names the libraries holding folder p, or a folder above it (a
// library on /media holds every /media/<name>). Jellyfin scans a path in
// one library only ("Found duplicate path"), so a second one stays empty.
func usedBy(fs []folder, p string) []string {
	names := []string{}
	for _, f := range fs {
		if slices.ContainsFunc(f.Locations, func(l string) bool {
			return l == p || strings.HasPrefix(p, strings.TrimSuffix(l, "/")+"/")
		}) {
			names = append(names, f.Name)
		}
	}
	return names
}

// taken refuses folder p if a library already holds it.
func taken(fs []folder, p string) error {
	if names := usedBy(fs, p); len(names) > 0 {
		return badRequest(fmt.Sprintf("%s is already in %s: Jellyfin keeps a folder in one library.",
			p, strings.Join(names, ", ")))
	}
	return nil
}

// CreateLibrary creates a library of in.Type over in.Folders with every
// fetcher off (an empty TypeOptions would mean every fetcher on) and the
// extras off, then Jellyfin scans it.
func (s *Setup) CreateLibrary(ctx context.Context, in NewLibrary) error {
	name := strings.TrimSpace(in.Name)
	paths, err := newLibraryPaths(name, in)
	if err != nil {
		return err
	}
	return s.asAdmin(ctx, func(admin string) error {
		fs, err := s.folders(ctx, admin)
		if err != nil {
			return err
		}
		if slices.ContainsFunc(fs, func(f folder) bool { return strings.EqualFold(f.Name, name) }) {
			return badRequest(fmt.Sprintf("There is already a library named %q.", name))
		}
		for _, p := range paths {
			if e := taken(fs, p["Path"]); e != nil {
				return e
			}
		}
		av, err := s.available(ctx, admin, in.Type, true)
		if err != nil {
			return err
		}
		opts := map[string]any{"PathInfos": paths, "TypeOptions": setFetchers(nil, av, false)}
		for _, k := range extras {
			opts[k] = false
		}
		b, _ := json.Marshal(map[string]any{"LibraryOptions": opts})
		q := url.Values{"name": {name}, "collectionType": {in.Type}, "refreshLibrary": {"true"}}
		return s.call(ctx, "POST", "/Library/VirtualFolders?"+q.Encode(), admin, string(b), nil)
	})
}

// newLibraryPaths checks a new library's body: its PathInfos, or why not.
func newLibraryPaths(name string, in NewLibrary) ([]map[string]string, error) {
	switch {
	case name == "":
		return nil, badRequest("Give the library a name.")
	case in.Type != "movies" && in.Type != "tvshows":
		return nil, badRequest(fmt.Sprintf("Unknown library type %q: movies or tvshows.", in.Type))
	case len(in.Folders) == 0:
		return nil, badRequest("Pick at least one folder.")
	}
	var paths []map[string]string
	for _, p := range in.Folders {
		c, err := mediaFolder(p)
		if err != nil {
			return nil, err
		}
		paths = append(paths, map[string]string{"Path": c})
	}
	return paths, nil
}

// AddFolder adds folder p (under mediaRoot) to library id; Jellyfin scans it.
func (s *Setup) AddFolder(ctx context.Context, id, p string) error {
	c, err := mediaFolder(p)
	if err != nil {
		return err
	}
	return s.asAdmin(ctx, func(admin string) error {
		fs, err := s.folders(ctx, admin)
		if err != nil {
			return err
		}
		i := slices.IndexFunc(fs, func(f folder) bool { return f.ItemId == id })
		if i < 0 {
			return errNoLibrary
		}
		if err := taken(fs, c); err != nil {
			return err
		}
		f := fs[i]
		b, _ := json.Marshal(map[string]any{"Name": f.Name, "PathInfo": map[string]string{"Path": c}})
		return s.call(ctx, "POST", "/Library/VirtualFolders/Paths?refreshLibrary=true", admin, string(b), nil)
	})
}

// RemoveFolder takes folder p out of library id, never its last one. The
// files stay; Jellyfin drops their items.
func (s *Setup) RemoveFolder(ctx context.Context, id, p string) error {
	c, err := mediaFolder(p)
	if err != nil {
		return err
	}
	return s.asAdmin(ctx, func(admin string) error {
		f, err := s.library(ctx, admin, id)
		if err != nil {
			return err
		}
		switch {
		case !slices.Contains(f.Locations, c):
			return badRequest(fmt.Sprintf("%s is not in %s.", c, f.Name))
		case len(f.Locations) == 1:
			return badRequest("A library keeps at least one folder: remove the library instead.")
		}
		q := url.Values{"name": {f.Name}, "path": {c}, "refreshLibrary": {"true"}}
		return s.call(ctx, "DELETE", "/Library/VirtualFolders/Paths?"+q.Encode(), admin, "", nil)
	})
}

// RemoveLibrary removes library id from Jellyfin; its files stay on disk.
func (s *Setup) RemoveLibrary(ctx context.Context, id string) error {
	return s.asAdmin(ctx, func(admin string) error {
		f, err := s.library(ctx, admin, id)
		if err != nil {
			return err
		}
		q := url.Values{"name": {f.Name}, "refreshLibrary": {"true"}}
		return s.call(ctx, "DELETE", "/Library/VirtualFolders?"+q.Encode(), admin, "", nil)
	})
}
