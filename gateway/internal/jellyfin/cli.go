package jellyfin

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
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
