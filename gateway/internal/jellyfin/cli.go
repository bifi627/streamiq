package jellyfin

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"golang.org/x/term"
)

// LoginCLI is `gateway jellyfin login` (#241): the local page's admin login,
// from a shell on the gateway box. It writes jellyfin.json; a running gateway
// re-reads it on its next poll (#240). readPw reads a line without echo; the
// password is never printed.
// ponytail: a viewer the running gateway saves between this Load and Login's save is lost; the member's next session makes it again.
func LoginCLI(ctx context.Context, s *Setup, in io.Reader, out io.Writer, readPw func() (string, error)) error {
	if err := s.Load(); err != nil {
		return err
	}
	before := s.View()
	fmt.Fprint(out, "Jellyfin administrator: ")
	user, err := bufio.NewReader(in).ReadString('\n')
	user = strings.TrimSpace(user)
	if user == "" {
		return errors.Join(errors.New("no user name"), err)
	}
	fmt.Fprint(out, "Password (not shown): ")
	pw, err := readPw()
	fmt.Fprintln(out)
	if err != nil {
		return err
	}
	if err := s.Login(ctx, user, pw); err != nil {
		return err
	}
	after := s.View()
	switch {
	case !after.Managed:
		fmt.Fprintf(out, "Reset the gateway's Jellyfin users %s and %s.\n", byoAdmin, ViewerName)
	case strings.EqualFold(user, before.User):
		fmt.Fprintf(out, "Stored the new %s password and reset %s.\n", before.User, ViewerName)
	default:
		fmt.Fprintf(out, "Reset %s. The stored %s password is unchanged: if Jellyfin refuses it, run this again as %s.\n", ViewerName, after.User, after.User)
	}
	fmt.Fprintf(out, "Saved to %s. A running gateway picks it up within a minute: check with `gateway status`.\n", s.path())
	return nil
}

// ErrInterrupted is Ctrl+C at the password prompt.
var ErrInterrupted = errors.New("interrupted")

// ReadPassword reads a line from the terminal f without echo. Raw mode, not
// term.ReadPassword: under ConPTY (Windows Terminal) Ctrl+C arrives as a byte,
// which that adds to the password; here it is ErrInterrupted on every OS.
func ReadPassword(f *os.File) (string, error) {
	old, err := term.MakeRaw(int(f.Fd()))
	if err != nil {
		return "", err
	}
	defer term.Restore(int(f.Fd()), old)
	return readLine(f)
}

func readLine(r io.Reader) (string, error) {
	var pw []byte
	b := make([]byte, 1)
	for {
		if _, err := io.ReadFull(r, b); err != nil {
			return "", err
		}
		switch b[0] {
		case '\r', '\n':
			return string(pw), nil
		case 3: // Ctrl+C
			return "", ErrInterrupted
		case '\b', 0x7f: // backspace: one character, not one byte
			_, n := utf8.DecodeLastRune(pw)
			pw = pw[:len(pw)-n]
		default:
			pw = append(pw, b[0])
		}
	}
}
