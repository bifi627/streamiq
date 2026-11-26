package jellyfin

import (
	"fmt"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

// MediaDir is where the jellyfin service's media folders are mounted (#431).
const MediaDir = "/media/"

// Mount is one item of the jellyfin service's volumes:.
type Mount struct {
	Source, Target string
	ReadWrite      bool
	bind           bool
	first, last    int // its lines: the dash, the last non-comment one
}

var (
	volumesKey = regexp.MustCompile(`^\s*volumes:\s*(#.*)?$`)
	itemKey    = regexp.MustCompile(`^([a-z_]+):(?:\s+(.*))?$`)
	plainYAML  = regexp.MustCompile(`^[\w./-]+$`)
)

// volumeItems finds the jellyfin service's volumes: list in ls: its items
// (unparsed spans) and the indent of their dashes. Commented-out items are
// not items.
func volumeItems(ls []string) (items []Mount, dash int, err error) {
	svc, end := jellyfinService(ls)
	if svc < 0 {
		return nil, 0, fmt.Errorf("%w: no jellyfin service under services:", errShape)
	}
	vol, ki := -1, -1
	for j := svc + 1; j < end && vol < 0; j++ {
		l := ls[j]
		if strings.TrimSpace(l) == "" || l[indent(l)] == '#' {
			continue
		}
		if indent(l) <= indent(ls[svc]) {
			break
		}
		if ki < 0 {
			ki = indent(l)
		}
		if indent(l) == ki && volumesKey.MatchString(l) {
			vol = j
		}
	}
	if vol < 0 {
		return nil, 0, fmt.Errorf("%w: the jellyfin service has no volumes: list", errShape)
	}
	dash = -1
list:
	for j := vol + 1; j < end; j++ {
		l := ls[j]
		t := strings.TrimSpace(l)
		if t == "" || t[0] == '#' {
			continue
		}
		isItem := t[0] == '-' && (dash < 0 || indent(l) == dash)
		if isItem && dash < 0 && indent(l) >= ki {
			dash = indent(l)
		}
		switch {
		case isItem && indent(l) == dash:
			items = append(items, Mount{first: j, last: j})
		case dash >= 0 && indent(l) > dash:
			items[len(items)-1].last = j
		default:
			break list // the next key
		}
	}
	if len(items) == 0 {
		return nil, 0, fmt.Errorf("%w: the jellyfin service's volumes: list has no items", errShape)
	}
	return items, dash, nil
}

// parseMount fills m from its lines: the short form (`- src:target[:ro]`) or
// the long one (`- type: bind`, source:, target:, read_only:).
func parseMount(ls []string, m Mount) Mount {
	first := strings.TrimSpace(ls[m.first])[1:]
	kv := itemKey.FindStringSubmatch(strings.TrimSpace(first))
	if kv == nil {
		return shortMount(scalar(first), m)
	}
	m.ReadWrite = true
	keys := indent(ls[m.first]) + 1 + indent(first) // the column of the dash line's key
	set := func(k, v string) {
		switch v = scalar(v); k {
		case "type":
			m.bind = v == "bind"
		case "source":
			m.Source = v
		case "target":
			m.Target = v
		case "read_only":
			m.ReadWrite = v != "true"
		}
	}
	set(kv[1], kv[2])
	for j := m.first + 1; j <= m.last; j++ {
		l := ls[j]
		if indent(l) != keys || l[indent(l)] == '#' {
			continue
		}
		if kv := itemKey.FindStringSubmatch(strings.TrimSpace(l)); kv != nil {
			set(kv[1], kv[2])
		}
	}
	return m
}

// shortMount reads `src:target[:mode]`; src may hold a drive letter's colon.
func shortMount(s string, m Mount) Mount {
	i := strings.LastIndex(s, ":/")
	if i < 0 {
		return m // a bare volume: no host folder
	}
	m.Source = s[:i]
	target, mode, _ := strings.Cut(s[i+1:], ":")
	m.Target = target
	m.ReadWrite = !slices.Contains(strings.Split(mode, ","), "ro")
	m.bind = strings.ContainsAny(m.Source, `/\.~`) // else a named volume
	return m
}

// scalar is a YAML scalar's value: quoted (single or double) or plain, with a
// trailing comment cut.
func scalar(v string) string {
	v = strings.TrimSpace(v)
	switch {
	case strings.HasPrefix(v, "'"):
		var b strings.Builder
		for i := 1; i < len(v); i++ {
			if v[i] == '\'' {
				if i+1 < len(v) && v[i+1] == '\'' {
					i++
				} else {
					break
				}
			}
			b.WriteByte(v[i])
		}
		return b.String()
	case strings.HasPrefix(v, `"`):
		if q, err := strconv.QuotedPrefix(v); err == nil {
			if s, err := strconv.Unquote(q); err == nil {
				return s
			}
		}
		return v
	}
	if i := strings.Index(v, " #"); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

// mounts parses every item of the jellyfin service's volumes:.
func mounts(ls []string) ([]Mount, int, error) {
	items, dash, err := volumeItems(ls)
	for i := range items {
		items[i] = parseMount(ls, items[i])
	}
	return items, dash, err
}

func (m Mount) media() bool { return m.bind && strings.HasPrefix(m.Target, MediaDir) }

// Mounts is every bind of the jellyfin service in a compose file whose target
// is under MediaDir, in file order.
func Mounts(b []byte) ([]Mount, error) {
	all, _, err := mounts(lines(b))
	if err != nil {
		return nil, err
	}
	var res []Mount
	for _, m := range all {
		if m.media() {
			res = append(res, m)
		}
	}
	return res, nil
}

// samePath compares host paths, a relative one taken from dir (the compose
// file's), either slash, case-insensitive on Windows.
func samePath(dir, a, b string) bool {
	abs := func(p string) string {
		p = strings.ReplaceAll(p, `\`, "/")
		if !strings.HasPrefix(p, "/") && (len(p) < 2 || p[1] != ':') {
			p = filepath.ToSlash(dir) + "/" + p
		}
		return filepath.ToSlash(filepath.Clean(p))
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(abs(a), abs(b))
	}
	return abs(a) == abs(b)
}

// PlainName says whether n can be a folder name under MediaDir.
func PlainName(n string) bool {
	return n != "" && n != "." && !strings.Contains(n, "..") &&
		!strings.ContainsAny(n, `/\`) && !strings.ContainsFunc(n, unicode.IsControl)
}

// AddMount adds a read-only bind source → MediaDir+name after the last media
// bind (the last item without one), in the long form with the file's indent
// and line ending; every other byte stays. name "" = source's base name, with
// " 2", " 3"… when that target is taken. dir is the compose file's (for its
// relative sources); source is absolute.
func AddMount(b []byte, dir, source, name string) (out []byte, m Mount, err error) {
	ls := lines(b)
	all, dash, err := mounts(ls)
	if err != nil {
		return nil, Mount{}, err
	}
	taken := func(n string) bool {
		return slices.ContainsFunc(all, func(m Mount) bool { return m.Target == MediaDir+n })
	}
	for _, m := range all {
		if m.bind && samePath(dir, m.Source, source) {
			return nil, Mount{}, fmt.Errorf("%s is already mounted at %s", source, m.Target)
		}
	}
	if name, err = mountName(source, name, taken); err != nil {
		return nil, Mount{}, err
	}
	at := all[len(all)-1].last
	for _, m := range all {
		if m.media() {
			at = m.last
		}
	}
	nl := "\n"
	if strings.Contains(string(b), "\r\n") {
		nl = "\r\n"
	}
	if !strings.HasSuffix(ls[at], "\n") {
		ls[at] += nl
	}
	m = Mount{Source: source, Target: MediaDir + name, bind: true}
	pad := strings.Repeat(" ", dash)
	target := m.Target
	if !plainYAML.MatchString(target) {
		target = quote(target)
	}
	item := []string{
		pad + "- type: bind" + nl,
		pad + "  source: " + quote(source) + nl,
		pad + "  target: " + target + nl,
		pad + "  read_only: true" + nl,
	}
	res := slices.Concat(ls[:at+1], item, ls[at+1:])
	return []byte(strings.Join(res, "")), m, nil
}

// mountName is name, checked, or the free one from source's base name.
func mountName(source, name string, taken func(string) bool) (string, error) {
	if name != "" {
		if !PlainName(name) {
			return "", fmt.Errorf("%q is not a plain folder name (no /, \\ or ..)", name)
		}
		if taken(name) {
			return "", fmt.Errorf("%s%s is taken: pick another --as", MediaDir, name)
		}
		return name, nil
	}
	s := strings.TrimRight(source, `/\`)
	base := s[strings.LastIndexAny(s, `/\`)+1:]
	if !PlainName(base) || strings.Contains(base, ":") {
		return "", fmt.Errorf("no folder name in %q: give one with --as", source)
	}
	name = base
	for i := 2; taken(name); i++ {
		name = fmt.Sprintf("%s %d", base, i)
	}
	return name, nil
}

// quote is s as a single-quoted YAML scalar (no escapes: Windows paths stay as typed).
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// RemoveMount removes every media bind whose target is which, or whose source
// is the host path which (relative sources taken from dir), with its lines;
// every other byte stays. An unknown one is an error.
func RemoveMount(b []byte, dir, which string) (out []byte, removed []Mount, err error) {
	ls := lines(b)
	all, _, err := mounts(ls)
	if err != nil {
		return nil, nil, err
	}
	for i := len(all) - 1; i >= 0; i-- {
		m := all[i]
		if m.media() && (m.Target == which || samePath(dir, m.Source, which)) {
			ls = slices.Delete(ls, m.first, m.last+1)
			removed = append([]Mount{m}, removed...)
		}
	}
	if len(removed) == 0 {
		return nil, nil, fmt.Errorf("no folder mounted at %s (see `gateway jellyfin folder list`)", which)
	}
	return []byte(strings.Join(ls, "")), removed, nil
}
