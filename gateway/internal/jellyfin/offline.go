package jellyfin

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
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

// Marked blocks: compose features the CLI toggles (#320). A block is the lines
// between `# streamiq:<name>` and `# streamiq:<name> end`; on = none of its
// lines is a comment, off = each is commented with "# " after its indent. A
// block holds no comments of its own, so the two states never mix.
var errShape = errors.New("not the shape the gateway expects")

func lines(b []byte) []string { return strings.SplitAfter(string(b), "\n") }

func indent(l string) int { return len(l) - len(strings.TrimLeft(l, " \t")) }

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
		return nil, false, fmt.Errorf("%w: the jail and online blocks are both %s", errShape, map[bool]string{true: "on", false: "off"}[jail])
	}
	if jail == offline {
		return b, false, nil
	}
	setBlock(ls, "jail", offline)
	setBlock(ls, "online", !offline)
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
		fmt.Fprintf(out, "%s is unchanged. Run `gateway jellyfin upgrade` first if it predates the jail, else:\n%s", file, manualJail)
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
		return err
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
	nl := "\n"
	if strings.Contains(string(b), "\r\n") {
		nl = "\r\n"
	}
	// The jellyfin service: under services:, ends at the first line indented no deeper.
	svc, end := -1, len(ls)
	for i, l := range ls {
		if servicesKey.MatchString(l) {
			for j := i + 1; j < len(ls); j++ {
				if t := strings.TrimSpace(ls[j]); t != "" && indent(ls[j]) == 0 {
					end = j // next top-level line (a comment above volumes: stays with it)
					break
				}
				if svc < 0 && jellyfinKey.MatchString(ls[j]) {
					svc = j
				}
			}
			break
		}
	}
	if svc < 0 {
		return nil, false, fmt.Errorf("%w: no jellyfin service under services:", errShape)
	}
	si := indent(ls[svc])
	ki, ports, portsEnd := -1, -1, -1
	for j := svc + 1; j < end; j++ {
		l := ls[j]
		if strings.TrimSpace(l) == "" || l[indent(l)] == '#' {
			continue
		}
		if indent(l) <= si {
			break
		}
		if ki < 0 {
			ki = indent(l)
		}
		if indent(l) != ki {
			continue
		}
		switch m := serviceKeyRe.FindStringSubmatch(l); {
		case m == nil:
		case m[1] == "networks" || m[1] == "network_mode":
			return nil, false, fmt.Errorf("%w: the jellyfin service already sets %s", errShape, m[1])
		case m[1] == "ports" && ports >= 0:
			return nil, false, fmt.Errorf("%w: two ports: keys", errShape)
		case m[1] == "ports":
			ports, portsEnd = j, j+1
			for portsEnd < end && strings.TrimSpace(ls[portsEnd]) != "" && indent(ls[portsEnd]) > ki {
				if ls[portsEnd][indent(ls[portsEnd])] == '#' {
					return nil, false, fmt.Errorf("%w: a comment inside the jellyfin service's ports:", errShape)
				}
				portsEnd++
			}
		}
	}
	if ports < 0 {
		return nil, false, fmt.Errorf("%w: the jellyfin service has no ports:", errShape)
	}
	pad, kpad := strings.Repeat(" ", si), strings.Repeat(" ", ki)
	withNL := func(l string) string {
		if !strings.HasSuffix(l, "\n") {
			return l + nl
		}
		return l
	}
	var portLines, commented []string
	for _, l := range ls[ports:portsEnd] {
		portLines = append(portLines, withNL(l))
		commented = append(commented, withNL(l[:indent(l)]+"# "+l[indent(l):]))
	}
	block := func(p, name string, body ...string) []string {
		return append(append([]string{p + "# streamiq:" + name + nl}, body...), p+"# streamiq:"+name+" end"+nl)
	}
	var res []string
	res = append(res, ls[:ports]...)
	res = append(res, block(kpad, "online", commented...)...)
	res = append(res, block(kpad, "jail", kpad+"networks: [jail]"+nl)...)
	res = append(res, ls[portsEnd:end]...)
	if n := len(res); n > 0 && !strings.HasSuffix(res[n-1], "\n") {
		res[n-1] += nl
	}
	res = append(res, pad+"# Offline (#321): the only way in to Jellyfin; `gateway jellyfin offline off` removes it."+nl)
	fw := []string{pad + "forwarder:" + nl,
		kpad + "image: " + Forwarder + nl,
		kpad + "restart: unless-stopped" + nl,
		kpad + "command: tcp-listen:8096,fork,reuseaddr tcp-connect:jellyfin:8096" + nl,
		kpad + "depends_on: [jellyfin]" + nl}
	fw = append(fw, portLines...)
	fw = append(fw, kpad+"networks: [jail, default]"+nl)
	res = append(res, block(pad, "jail", fw...)...)
	res = append(res, ls[end:]...)
	if n := len(res); !strings.HasSuffix(res[n-1], "\n") {
		res[n-1] += nl
	}
	res = append(res, block("", "jail", "networks:"+nl, pad+"jail:"+nl, pad+pad+"internal: true"+nl)...)
	return []byte(strings.Join(res, "")), true, nil
}
