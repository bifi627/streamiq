package jellyfin

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"slices"
	"strings"
)

// Forwarder is the socat image that publishes Jellyfin's port while Jellyfin
// sits on the jail network (#321; TestPinsMatchTested).
const Forwarder = "alpine/socat:1.8.0.3"

// Offline states, as GET /streamiq/status and the local page report them.
const (
	OfflineEnforced = "enforced" // the jail is on: Jellyfin has no way out
	OfflineAllowed  = "allowed"  // Jellyfin can reach the internet (online lookups)
)

// errShape: a compose file the gateway won't edit, never a guess.
var errShape = errors.New("not the shape the gateway expects")

func lines(b []byte) []string { return strings.SplitAfter(string(b), "\n") }

func indent(l string) int { return len(l) - len(strings.TrimLeft(l, " \t")) }

// Marked blocks: compose features the CLI toggles (#320). A block is the lines
// between `# streamiq:<name>` and `# streamiq:<name> end`; on = none of its
// lines is a comment, off = each is commented with "# " after its indent. A
// block holds no comments of its own, so the two states never mix.
//
// marked returns the indexes of the non-blank lines inside every <name> block.
func marked(ls []string, name string) ([]int, error) {
	begin, end := "# streamiq:"+name, "# streamiq:"+name+" end"
	var idx []int
	in := false
	for i, l := range ls {
		switch t := strings.TrimSpace(l); {
		case t == begin && !in, t == end && in:
			in = !in
		case t == begin || t == end:
			return nil, fmt.Errorf("%w: unbalanced %q (line %d)", errShape, t, i+1)
		case in && t != "":
			idx = append(idx, i)
		}
	}
	if in {
		return nil, fmt.Errorf("%w: %q without %q", errShape, begin, end)
	}
	if len(idx) == 0 {
		return nil, fmt.Errorf("%w: no %q block", errShape, begin)
	}
	return idx, nil
}

// blockOn says whether the <name> blocks are on; an error if they're missing or mixed.
func blockOn(ls []string, name string) (bool, error) {
	idx, err := marked(ls, name)
	if err != nil {
		return false, err
	}
	n := 0
	for _, i := range idx {
		if strings.HasPrefix(ls[i][indent(ls[i]):], "# ") {
			n++
		} else if ls[i][indent(ls[i])] == '#' {
			return false, fmt.Errorf("%w: line %d in a %q block", errShape, i+1, name)
		}
	}
	if n != 0 && n != len(idx) {
		return false, fmt.Errorf("%w: the %q blocks are partly commented out", errShape, name)
	}
	return n == 0, nil
}

// setBlock (un)comments every line of the <name> blocks and touches nothing else.
func setBlock(ls []string, name string, on bool) error {
	cur, err := blockOn(ls, name)
	if err != nil || cur == on {
		return err
	}
	idx, _ := marked(ls, name)
	for _, i := range idx {
		l, n := ls[i], indent(ls[i])
		if on {
			ls[i] = l[:n] + l[n+2:]
		} else {
			ls[i] = l[:n] + "# " + l[n:]
		}
	}
	return nil
}

// SetOffline turns the jail on (offline) or off: the jail blocks and the plain
// `ports:` (online) block are opposites. changed is false if it already was.
func SetOffline(b []byte, offline bool) (out []byte, changed bool, err error) {
	ls := lines(b)
	jail, err := blockOn(ls, "jail")
	if err != nil {
		return nil, false, err
	}
	online, err := blockOn(ls, "online")
	if err != nil {
		return nil, false, err
	}
	if jail == online {
		return nil, false, fmt.Errorf(
			"%w: the jail and online blocks are both %s",
			errShape,
			map[bool]string{true: "on", false: "off"}[jail],
		)
	}
	if jail == offline {
		return b, false, nil
	}
	if err := setBlock(ls, "jail", offline); err != nil {
		return nil, false, err
	}
	if err := setBlock(ls, "online", !offline); err != nil {
		return nil, false, err
	}
	return []byte(strings.Join(ls, "")), true, nil
}

// Offline reads the jail state from the compose file: "" without one (a
// Jellyfin the user brought, or dev), else OfflineEnforced / OfflineAllowed.
func Offline(file string) string {
	b, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	if on, err := blockOn(lines(b), "jail"); err == nil && on {
		return OfflineEnforced
	}
	return OfflineAllowed
}

const manualJail = `To do it by hand (docs/install.md, "Offline Jellyfin"): jailed = the jellyfin
service has networks: [jail] instead of ports:, plus the forwarder service and the
networks: block from the latest gateway release's jellyfin-compose.yml; online =
the jellyfin service's ports: back, without those.
`

// OfflineCLI is `gateway jellyfin offline on|off`: toggles the marked blocks and restarts Jellyfin.
func OfflineCLI(ctx context.Context, file string, offline bool, out io.Writer) error {
	b, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("no %s: this only works for the Jellyfin `gateway jellyfin up` runs", file)
	}
	if err != nil {
		return err
	}
	res, changed, err := SetOffline(b, offline)
	if err != nil {
		fmt.Fprintf(
			out,
			"%s is unchanged. Run `gateway jellyfin upgrade` first if it predates the jail, else:\n%s",
			file,
			manualJail,
		)
		return err
	}
	state := map[bool]string{true: "offline: nothing leaves the Jellyfin container", false: "online: lookups (posters, descriptions) allowed"}[offline]
	if !changed {
		fmt.Fprintln(out, "Jellyfin is already", state)
		return nil
	}
	if err := os.WriteFile(file, res, 0o644); err != nil {
		return err
	}
	// --remove-orphans: turning the jail off comments the forwarder out, and its
	// container still holds the port Jellyfin publishes again.
	if err := Compose(ctx, file, "up", "-d", "--remove-orphans"); err != nil {
		// the status reads the file: keep it saying what runs
		return errors.Join(err, os.WriteFile(file, b, 0o644))
	}
	fmt.Fprintln(out, "Jellyfin is now", state)
	return nil
}

var (
	servicesKey  = regexp.MustCompile(`^services:\s*$`)
	jellyfinKey  = regexp.MustCompile(`^(\s+)jellyfin:\s*$`)
	topNetworks  = regexp.MustCompile(`(?m)^networks:`)
	alreadyJail  = regexp.MustCompile(`(?m)^\s*# streamiq:jail\s*$`)
	serviceKeyRe = regexp.MustCompile(`^\s*([A-Za-z_]+):`)
)

// Jail migrates a compose file without markers (before #321) to the jail by a
// partial edit, like Pin: the jellyfin service's ports: becomes a commented
// online block plus networks: [jail], the forwarder service (publishing those
// same ports) and the networks: block are added, every other byte stays. A file
// with the markers keeps the user's choice (changed false).
func Jail(b []byte) (out []byte, changed bool, err error) {
	if alreadyJail.Match(b) {
		return b, false, nil
	}
	if topNetworks.Match(b) {
		return nil, false, fmt.Errorf("%w: it has its own networks: block", errShape)
	}
	ls := lines(b)
	if ls[len(ls)-1] == "" {
		ls = ls[:len(ls)-1] // SplitAfter's empty tail after the last newline
	}
	svc, err := findJellyfin(ls)
	if err != nil {
		return nil, false, err
	}
	nl := "\n"
	if strings.Contains(string(b), "\r\n") {
		nl = "\r\n"
	}
	return jailed(ls, svc, nl), true, nil
}

// jellyfinSpan is where the jellyfin service and its ports: sit in a compose file's lines.
type jellyfinSpan struct {
	indent, keyIndent int // of the service's name, of its keys
	ports, portsEnd   int // the ports: key, the line after its last item
	end               int // the line after the services: block
}

// findJellyfin locates the jellyfin service and its ports: key.
func findJellyfin(ls []string) (jellyfinSpan, error) {
	svc, end := jellyfinService(ls)
	if svc < 0 {
		return jellyfinSpan{}, fmt.Errorf("%w: no jellyfin service under services:", errShape)
	}
	ki, ports, portsEnd, err := portsKey(ls, svc, end)
	if err != nil {
		return jellyfinSpan{}, err
	}
	return jellyfinSpan{indent: indent(ls[svc]), keyIndent: ki, ports: ports, portsEnd: portsEnd, end: end}, nil
}

// jellyfinService returns the jellyfin service's line (-1 without one) and the
// end of the services: block: the next top-level key, less the column-0
// comments right above it (they stay with it, above volumes:). A #-line at
// column 0 doesn't end the block: it may be a commented-out mount. Only a
// jellyfin: at the indent of the service names counts, not one nested in
// another service (its depends_on:, #584).
func jellyfinService(ls []string) (svc, end int) {
	svc, end = -1, len(ls)
	i := slices.IndexFunc(ls, servicesKey.MatchString)
	if i < 0 {
		return svc, end
	}
	names := -1 // the indent of the service names: the first key under services:
	for j := i + 1; j < len(ls); j++ {
		t := strings.TrimSpace(ls[j])
		if t == "" || t[0] == '#' {
			continue
		}
		if indent(ls[j]) == 0 {
			end = j
			for end > i+1 && strings.HasPrefix(ls[end-1], "#") {
				end--
			}
			break
		}
		if names < 0 {
			names = indent(ls[j])
		}
		if svc < 0 && indent(ls[j]) == names && jellyfinKey.MatchString(ls[j]) {
			svc = j
		}
	}
	return svc, end
}

// portsKey walks the keys of the service at line svc (up to end) and returns
// their indent and the ports: key with the line after its items.
func portsKey(ls []string, svc, end int) (ki, ports, portsEnd int, err error) {
	ki, ports, portsEnd = -1, -1, -1
	for j := svc + 1; j < end; j++ {
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
		if indent(l) != ki {
			continue
		}
		key, err := serviceKey(l, j)
		if err != nil {
			return 0, 0, 0, err
		}
		if key != "ports" {
			continue
		}
		if ports >= 0 {
			return 0, 0, 0, fmt.Errorf("%w: two ports: keys", errShape)
		}
		ports = j
		if portsEnd, err = portItems(ls, j, end, ki); err != nil {
			return 0, 0, 0, err
		}
	}
	if ports < 0 {
		return 0, 0, 0, fmt.Errorf("%w: the jellyfin service has no ports:", errShape)
	}
	return ki, ports, portsEnd, nil
}

// serviceKey is the key on line l (index j) of the jellyfin service; an error
// for a non-key and for a network setting of its own (the jail sets those).
func serviceKey(l string, j int) (string, error) {
	m := serviceKeyRe.FindStringSubmatch(l)
	switch {
	case m == nil:
		return "", fmt.Errorf("%w: line %d is not a key of the jellyfin service", errShape, j+1)
	case m[1] == "networks" || m[1] == "network_mode":
		return "", fmt.Errorf("%w: the jellyfin service already sets %s", errShape, m[1])
	}
	return m[1], nil
}

// portItems returns the line after the items of the ports: key at line ports
// (keys indented ki, the service ending at end). Every item gets copied to the
// forwarder, so a comment among them is refused, and so is an item after a
// blank line or a column-0 comment, which ended the span.
func portItems(ls []string, ports, end, ki int) (int, error) {
	pe := ports + 1
	for ; pe < end && strings.TrimSpace(ls[pe]) != "" && indent(ls[pe]) > ki; pe++ {
		if ls[pe][indent(ls[pe])] == '#' {
			return 0, fmt.Errorf("%w: a comment inside the jellyfin service's ports:", errShape)
		}
	}
	for k := pe; k < end; k++ {
		if t := strings.TrimSpace(ls[k]); t != "" && t[0] != '#' {
			if indent(ls[k]) > ki {
				return 0, fmt.Errorf("%w: a blank line or comment inside the jellyfin service's ports:", errShape)
			}
			break
		}
	}
	return pe, nil
}

// jailed writes the migrated file: ls with svc's ports: swapped for the online
// and jail blocks, the forwarder at the end of services:, the networks: block last.
func jailed(ls []string, svc jellyfinSpan, nl string) []byte {
	pad, kpad := strings.Repeat(" ", svc.indent), strings.Repeat(" ", svc.keyIndent)
	withNL := func(l string) string {
		if !strings.HasSuffix(l, "\n") {
			return l + nl
		}
		return l
	}
	var portLines, commented []string
	for _, l := range ls[svc.ports:svc.portsEnd] {
		portLines = append(portLines, withNL(l))
		commented = append(commented, withNL(l[:indent(l)]+"# "+l[indent(l):]))
	}
	block := func(p, name string, body ...string) []string {
		return append(append([]string{p + "# streamiq:" + name + nl}, body...), p+"# streamiq:"+name+" end"+nl)
	}
	var res []string
	res = append(res, ls[:svc.ports]...)
	res = append(res, block(kpad, "online", commented...)...)
	res = append(res, block(kpad, "jail", kpad+"networks: [jail]"+nl)...)
	res = append(res, ls[svc.portsEnd:svc.end]...)
	if n := len(res); n > 0 && !strings.HasSuffix(res[n-1], "\n") {
		res[n-1] += nl
	}
	res = append(
		res,
		pad+"# Offline (#321): the only way in to Jellyfin; `gateway jellyfin offline off` removes it."+nl,
	)
	fw := []string{pad + "forwarder:" + nl,
		kpad + "image: " + Forwarder + nl,
		kpad + "restart: unless-stopped" + nl,
		kpad + "command: tcp-listen:8096,fork,reuseaddr tcp-connect:jellyfin:8096" + nl,
		kpad + "depends_on: [jellyfin]" + nl}
	fw = append(fw, portLines...)
	fw = append(fw, kpad+"networks: [jail, default]"+nl)
	res = append(res, block(pad, "jail", fw...)...)
	res = append(res, ls[svc.end:]...)
	if n := len(res); !strings.HasSuffix(res[n-1], "\n") {
		res[n-1] += nl
	}
	res = append(res, block("", "jail", "networks:"+nl, pad+"jail:"+nl, pad+pad+"internal: true"+nl)...)
	return []byte(strings.Join(res, ""))
}
