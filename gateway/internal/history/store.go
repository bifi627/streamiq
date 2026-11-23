// Package history keeps the gateway's own records in its state dir: JSON
// Lines, one file per UTC day, each kind its own number of days. ponytail: plain files, a
// store behind Append / Read (SQLite, say) if the reads ever need an index.
package history

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// Dir is the history's directory in the state dir; backup and restore carry it.
const Dir = "history"

// HealthDays and TunnelDays: how many days back each kind's day files are kept.
const (
	HealthDays = 7
	TunnelDays = 30
)

const day = "2006-01-02"

// Store is one kind of record: <Dir>/<Kind>-YYYY-MM-DD.jsonl.
type Store struct {
	Dir  string
	Kind string
	Days int // day files more than Days before today's are deleted
	mu   sync.Mutex
}

// Append writes v as one line to now's day file, then deletes the day files past Days.
func (s *Store) Append(now time.Time, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err = os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(s.file(now), os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if torn(f) { // a crash mid-write left a line without its end: never glue onto it
		b = append([]byte("\n"), b...)
	}
	_, err = f.Write(append(b, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return s.prune(now)
}

// torn reports whether f's last byte isn't a line end.
func torn(f *os.File) bool {
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return false
	}
	last := make([]byte, 1)
	_, err = f.ReadAt(last, st.Size()-1)
	return err == nil && last[0] != '\n'
}

func (s *Store) file(t time.Time) string {
	return filepath.Join(s.Dir, s.Kind+"-"+t.UTC().Format(day)+".jsonl")
}

// days is the store's day files, oldest first.
func (s *Store) days() ([]string, error) {
	files, err := filepath.Glob(filepath.Join(s.Dir, s.Kind+"-*.jsonl"))
	slices.Sort(files)
	return files, err
}

// prune deletes the day files more than Days before now's day.
func (s *Store) prune(now time.Time) error {
	files, err := s.days()
	if err != nil {
		return err
	}
	oldest := now.UTC().AddDate(0, 0, -s.Days).Format(day)
	for _, f := range files {
		d := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(f), s.Kind+"-"), ".jsonl")
		if d < oldest {
			if err := os.Remove(f); err != nil {
				return err
			}
		}
	}
	return nil
}

// Read decodes every stored record, oldest day first, in file order; a line that
// doesn't decode (torn by a crash) is skipped.
func Read[T any](s *Store) ([]T, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	files, err := s.days()
	if err != nil {
		return nil, err
	}
	var out []T
	for _, name := range files {
		if out, err = readFile(name, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func readFile[T any](name string, out []T) ([]T, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var v T
		if json.Unmarshal(sc.Bytes(), &v) == nil {
			out = append(out, v)
		}
	}
	return out, sc.Err()
}
