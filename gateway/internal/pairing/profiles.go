package pairing

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// profiles holds each paired client's last capability probe (profiles.json in
// the state dir), apart from allowlist.json: it's written on every playback
// start, and a torn or unreadable file only loses the profiles, never stops the
// gateway from starting.
type profiles struct {
	path string
	mu   sync.Mutex
	m    map[string]Profile
}

func openProfiles(dir string) *profiles {
	p := &profiles{path: filepath.Join(dir, "profiles.json"), m: map[string]Profile{}}
	b, err := os.ReadFile(p.path)
	if err == nil && json.Unmarshal(b, &p.m) != nil {
		log.Printf("gateway: %s unreadable, client profiles start empty", p.path)
		p.m = map[string]Profile{}
	}
	return p
}

func (p *profiles) of(keyFp string) *Profile {
	p.mu.Lock()
	defer p.mu.Unlock()
	if v, ok := p.m[keyFp]; ok {
		return &v
	}
	return nil
}

// set stores in as keyFp's profile, stamped now; a failed save keeps the old one.
func (p *profiles) set(keyFp string, in ProfileIn) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	old, had := p.m[keyFp]
	p.m[keyFp] = Profile{in.Probe, in.Compatible, time.Now().UTC().Truncate(time.Second)}
	if err := p.save(); err != nil {
		if had {
			p.m[keyFp] = old
		} else {
			delete(p.m, keyFp)
		}
		return err
	}
	return nil
}

// drop forgets a removed client's profile; a failed save is only logged (no
// one is shown a profile without its allowlist entry).
func (p *profiles) drop(keyFp string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.m[keyFp]; !ok {
		return
	}
	delete(p.m, keyFp)
	if err := p.save(); err != nil {
		log.Printf("gateway: drop client profile: %v", err)
	}
}

// save writes a temp file and renames it over profiles.json: a crash leaves
// the old file or the new one, never half of one. Caller holds mu.
func (p *profiles) save() error {
	b, _ := json.MarshalIndent(p.m, "", " ")
	if err := os.MkdirAll(filepath.Dir(p.path), 0o700); err != nil {
		return err
	}
	tmp := p.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.path)
}
