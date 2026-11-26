package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"golang.org/x/term"

	"streamiq/gateway/internal/backup"
	"streamiq/gateway/internal/jellyfin"
	"streamiq/gateway/internal/localpage"
	"streamiq/gateway/internal/service"
)

// usageError is wrong input (unknown command, bad arguments or flags): main
// prints the command's usage after it and exits 2.
type usageError struct{ error }

// args wraps a cobra argument validator so its errors are usage errors. A "help"
// argument shows the help (not a file named help: gateway backup help).
func args(v cobra.PositionalArgs) cobra.PositionalArgs {
	return func(c *cobra.Command, a []string) error {
		if slices.Contains(a, "help") {
			return pflag.ErrHelp // cobra prints the help, exit 0
		}
		if err := v(c, a); err != nil {
			return usageError{err}
		}
		return nil
	}
}

// unknown is the error for a mistyped command, with cobra's "Did you mean …?" hint.
func unknown(c *cobra.Command, a []string) error {
	if len(a) == 0 {
		return usageError{fmt.Errorf("%q needs a command", c.CommandPath())}
	}
	msg := fmt.Sprintf("unknown command %q for %q", a[0], c.CommandPath())
	c.SuggestionsMinimumDistance = 2 // cobra's default, which it only sets in its own lookup
	if s := c.SuggestionsFor(a[0]); len(s) > 0 {
		msg += "\n\nDid you mean this?\n\t" + strings.Join(s, "\n\t")
	}
	return usageError{errors.New(msg)}
}

// group is a command that only holds subcommands: without a valid one it's a usage error
// (cobra would print help and exit 0).
func group(c *cobra.Command, sub ...*cobra.Command) *cobra.Command {
	c.Args = cobra.ArbitraryArgs
	c.RunE = func(c *cobra.Command, a []string) error { return unknown(c, a) }
	c.AddCommand(sub...)
	return c
}

// zipFiles completes an argument that is a backup file.
func zipFiles(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	return []string{"zip"}, cobra.ShellCompDirectiveFilterFileExt
}

// none: a command takes no arguments; noFiles: its shell completion offers no files.
var (
	none    = args(cobra.NoArgs)
	noFiles = cobra.NoFileCompletions
)

// newRoot is the gateway CLI; exe is this binary (its directory holds
// gateway.env and jellyfin-compose.yml).
func newRoot(ctx context.Context, exe string) *cobra.Command {
	compose := filepath.Join(filepath.Dir(exe), jellyfin.ComposeFile)
	runGateway := func(*cobra.Command, []string) {
		// stopGateway finds this copy by it, however it was started (./gateway, gateway run).
		// Not over a running copy's pid (this one then dies on the page port), and
		// best effort: a read-only install dir (the Docker image) has no use for it.
		if notRunning() == nil {
			_ = os.WriteFile(exe+".pid", []byte(strconv.Itoa(os.Getpid())), 0o600)
		}
		run(ctx, compose)
	}

	root := &cobra.Command{
		Use:   "gateway",
		Short: "StreamIQ gateway: tunnels your Jellyfin to your browsers",
		Long: `StreamIQ gateway: tunnels the Jellyfin on this machine to your paired browsers.
Without a command it runs the gateway (as "gateway run").

Config: gateway.env next to the binary (see docs/install.md).`,
		Example: `  gateway                  run the gateway
  gateway status           show the running gateway's status
  gateway help backup      help for one command`,
		Args: args(func(c *cobra.Command, a []string) error {
			if len(a) > 0 {
				return unknown(c, a)
			}
			return nil
		}),
		ValidArgsFunction: noFiles,
		Run:               runGateway,
		SilenceErrors:     true, // main prints "gateway: <err>"
		SilenceUsage:      true, // and the usage only for usage errors
	}
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error { return usageError{err} })
	root.AddGroup(
		&cobra.Group{ID: "gateway", Title: "Gateway:"},
		&cobra.Group{ID: "update", Title: "Updates:"},
		&cobra.Group{ID: "jellyfin", Title: "Jellyfin:"},
		&cobra.Group{ID: "backup", Title: "Backup:"},
	)

	root.AddCommand(slices.Concat(
		gatewayCmds(ctx, exe, runGateway),
		updateCmds(ctx, exe),
		jellyfinCmds(ctx, exe, compose),
		backupCmds(ctx, compose),
	)...)
	return root
}

// gatewayCmds are the "Gateway:" group.
func gatewayCmds(ctx context.Context, exe string, runGateway func(*cobra.Command, []string)) []*cobra.Command {
	task := service.Task(exe)
	return []*cobra.Command{
		{
			Use: "run", GroupID: "gateway", Args: none, ValidArgsFunction: noFiles,
			Short:   "Run the gateway (the default)",
			Long:    "Run the gateway in this window until Ctrl+C. Same as \"gateway\" without a command.",
			Example: "  gateway run",
			Run:     runGateway,
		},
		{
			Use: "status", GroupID: "gateway", Args: none, ValidArgsFunction: noFiles,
			Short:   "Show the running gateway's status",
			Long:    "Show the running gateway's status, from its local gateway page.",
			Example: "  gateway status",
			RunE: func(*cobra.Command, []string) error {
				link, _ := os.ReadFile(filepath.Join(stateDir(), "page-link"))
				return localpage.PrintStatus(ctx, os.Stdout, pagePort(), strings.TrimSpace(string(link)))
			},
		},
		{
			Use:               "version",
			GroupID:           "gateway",
			Args:              none,
			ValidArgsFunction: noFiles,
			Short:             "Print this binary's version",
			Example:           "  gateway version",
			Run:               func(*cobra.Command, []string) { fmt.Println(version) }, // install.sh / install.ps1 name the pre-update backup with it
		},
		group(&cobra.Command{
			Use:     "service",
			GroupID: "gateway",
			Short:   "Start the gateway at logon in its own window (Windows)",
			Long:    "Start the gateway at logon in its own console window, as a Windows scheduled task (" + task + ").",
		},
			&cobra.Command{
				Use: "install", Args: none, ValidArgsFunction: noFiles,
				Short: "Install and start the logon task",
				Long: `Install and start the logon task. Enrolls the gateway first if it isn't yet
(STREAMIQ_ENROLL_TOKEN; the installer does this).`,
				Example: "  gateway service install",
				RunE:    func(*cobra.Command, []string) error { return serviceInstall(ctx, exe) },
			},
			&cobra.Command{
				Use: "uninstall", Args: none, ValidArgsFunction: noFiles,
				Short:   "Remove the logon task and stop the gateway",
				Long:    "Remove the logon task and stop the gateway. state/ and gateway.env are kept.",
				Example: "  gateway service uninstall",
				RunE: func(*cobra.Command, []string) error {
					if err := service.Uninstall(exe); err != nil {
						return err
					}
					fmt.Println("Removed the logon task and stopped the gateway. state/ and gateway.env are kept.")
					return nil
				},
			},
		),
		{
			Use:       "relay on|off",
			GroupID:   "gateway",
			Args:      args(cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs)),
			ValidArgs: []string{"on", "off"},
			Short:     "Allow the relay (on, the default) or direct connections only (off)",
			Long: `on (the default): a client that can't connect directly goes through the relay (TURN).
off: direct connections only, the stream never passes through the relay; clients behind
carrier NAT (most cellular) or a strict NAT can't connect. Refuses while the gateway runs
(the web gateway card switches it on a running one).`,
			Example: "  gateway relay off\n  gateway relay on",
			RunE:    func(_ *cobra.Command, a []string) error { return setRelay(a[0] == "on") },
		},
		{
			Use: "reset-identity", GroupID: "gateway", Args: none, ValidArgsFunction: noFiles,
			Short: "New identity key + empty paired-browser list",
			Long: `New identity key + empty paired-browser list: every browser pairs again (after a
leak; docs/install.md). Refuses while the gateway runs.`,
			Example: "  gateway reset-identity",
			RunE:    func(*cobra.Command, []string) error { return resetIdentity() },
		},
	}
}

// updateCmds are the "Updates:" group.
func updateCmds(ctx context.Context, exe string) []*cobra.Command {
	return []*cobra.Command{
		{
			Use: "update", GroupID: "update", Args: none, ValidArgsFunction: noFiles,
			Short: "Install the latest release (Windows)",
			Long: `Install the latest release (Windows). Keeps the old binary and a state backup
in backups/ (the last 3 updates), for "gateway rollback".`,
			Example: "  gateway update",
			RunE:    func(*cobra.Command, []string) error { return selfUpdate(ctx, exe) },
		},
		{
			Use: "rollback", GroupID: "update", Args: none, ValidArgsFunction: noFiles,
			Short: "Go back to the version before the last update",
			Long: `Go back to the version before the last update: stops the gateway, puts the old
binary and its state back, starts it again.`,
			Example: "  gateway rollback",
			RunE:    func(*cobra.Command, []string) error { return rollback(ctx, exe) },
		},
	}
}

// jellyfinCmds are the "Jellyfin:" group.
func jellyfinCmds(ctx context.Context, exe, compose string) []*cobra.Command {
	return []*cobra.Command{
		group(&cobra.Command{
			Use:     "jellyfin",
			GroupID: "jellyfin",
			Short:   "Run, configure and repair the Jellyfin the gateway set up",
			Long:    "Run, configure and repair Jellyfin. up, upgrade, offline, gpu and folder drive the Docker Jellyfin from jellyfin-compose.yml.",
			Example: `  gateway jellyfin up
  gateway jellyfin folder add "D:\My Movies"   mount a folder for a library`,
		},
			folderCmd(ctx, compose),
			&cobra.Command{
				Use:               "up",
				Args:              none,
				ValidArgsFunction: noFiles,
				Short:             "Start Jellyfin in Docker",
				Long:              "Start Jellyfin in Docker (downloads jellyfin-compose.yml once: point its media folders at yours, then run it again).",
				Example:           "  gateway jellyfin up",
				RunE:              func(*cobra.Command, []string) error { return jellyfinUp(ctx, compose) },
			},
			&cobra.Command{
				Use: "upgrade", Args: none, ValidArgsFunction: noFiles,
				Short: "Pin jellyfin-compose.yml to the tested Jellyfin and restart it",
				Long: `Pin jellyfin-compose.yml to the tested Jellyfin (and move a file from before
the offline jail into it), then restart it.`,
				Example: "  gateway jellyfin upgrade",
				RunE:    func(*cobra.Command, []string) error { return jellyfin.Upgrade(ctx, compose, os.Stdout) },
			},
			&cobra.Command{
				Use: "offline on|off", Args: args(cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs)),
				ValidArgs: []string{"on", "off"},
				Short:     "Cut Jellyfin off the internet (on) or allow online lookups (off)",
				Long: `on (the default): Jellyfin has no internet access, nothing leaves it.
off: online lookups (posters, descriptions) allowed. Restarts Jellyfin.`,
				Example: "  gateway jellyfin offline off\n  gateway jellyfin offline on",
				RunE: func(_ *cobra.Command, a []string) error {
					return jellyfin.OfflineCLI(ctx, compose, a[0] == "on", os.Stdout)
				},
			},
			&cobra.Command{
				Use: "gpu nvidia|off", Args: args(cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs)),
				ValidArgs: []string{"nvidia", "off"},
				Short:     "Transcode on an NVIDIA GPU, or on the CPU again",
				Long: `nvidia: transcode on an NVIDIA GPU (checks Jellyfin sees it, else changes nothing).
off: on the CPU again. Restarts Jellyfin and the gateway.`,
				Example: "  gateway jellyfin gpu nvidia\n  gateway jellyfin gpu off",
				RunE: func(_ *cobra.Command, a []string) error {
					return jellyfin.GPUCLI(ctx, compose, filepath.Join(filepath.Dir(exe), "gateway.env"),
						a[0] == "nvidia", func() error { return restartGateway(exe) }, os.Stdout)
				},
			},
			&cobra.Command{
				Use: "login", Args: none, ValidArgsFunction: noFiles,
				Short: "Sign in with a Jellyfin admin to repair the gateway's access",
				Long: `Sign in with a Jellyfin admin to repair the gateway's access (as the local
gateway page does; docs/install.md). Needs a terminal: the password isn't shown.`,
				Example: "  gateway jellyfin login",
				RunE:    func(*cobra.Command, []string) error { return jellyfinLogin(ctx) },
			},
			&cobra.Command{
				Use: "restore <file>", Args: args(cobra.ExactArgs(1)), ValidArgsFunction: zipFiles,
				Short: "Put a gateway backup's Jellyfin data back",
				Long: `Put the Jellyfin data of a gateway backup back into the Jellyfin the gateway set
up (users, libraries, watch state). Replaces what it has. Refuses while the
gateway runs; docs/install.md for the order.`,
				Example: "  gateway jellyfin restore streamiq-gateway-home-2026-11-17-093000.zip",
				RunE:    func(_ *cobra.Command, a []string) error { return jellyfinRestore(ctx, a[0], compose) },
			},
		),
	}
}

// backupCmds are the "Backup:" group.
func backupCmds(ctx context.Context, compose string) []*cobra.Command {
	cmds := []*cobra.Command{
		{
			Use: "backup [file]", GroupID: "backup", Args: args(cobra.MaximumNArgs(1)),
			Short: "Write the gateway's state (and Jellyfin's database) to one zip",
			Long: `Write the state dir (identity, credential, paired browsers, Jellyfin login),
jellyfin-compose.yml and, for the Jellyfin the gateway set up, Jellyfin's
database to one zip; works while the gateway runs. Without a file name it
writes streamiq-gateway-<name>-<date>-<time>.zip in the current folder.
The zip is NOT encrypted: keep it like a password.`,
			Example: "  gateway backup\n  gateway backup D:\\keep\\gw.zip",
			RunE: func(_ *cobra.Command, a []string) error {
				file := backup.FileName(stateDir(), time.Now())
				if len(a) == 1 {
					file = a[0]
				}
				return backupState(ctx, file, compose)
			},
		},
	}
	restore := &cobra.Command{
		Use: "restore <file>", GroupID: "backup", Args: args(cobra.ExactArgs(1)), ValidArgsFunction: zipFiles,
		Short: "Put a backup back into the state dir",
		Long: `Put a backup back into the state dir. Refuses while the gateway runs, and over
an existing gateway unless --force. Writes jellyfin-compose.yml only if there
is none (never over one, not even with --force). Jellyfin's data stays in the
zip: gateway jellyfin restore.`,
		Example: "  gateway restore gw.zip\n  gateway restore --force gw.zip",
	}
	force := restore.Flags().Bool("force", false, "replace the gateway already in the state dir")
	restore.RunE = func(_ *cobra.Command, a []string) error { return restoreState(a[0], compose, *force) }
	return append(cmds, restore)
}

// jellyfinLogin is `gateway jellyfin login`.
func jellyfinLogin(ctx context.Context) error {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return errors.New("run it in a terminal: it reads the password without showing it")
	}
	// The user name prompt doesn't watch ctx: Ctrl+C there (caught by
	// NotifyContext) exits here. At the password prompt it is a byte (raw mode).
	defer exitOnCancel(ctx, os.Exit)()
	err := jellyfin.LoginCLI(
		ctx,
		jellyfinSetup(),
		os.Stdin,
		os.Stdout,
		func() (string, error) { return jellyfin.ReadPassword(os.Stdin) },
	)
	if errors.Is(err, jellyfin.ErrInterrupted) || (err != nil && ctx.Err() != nil) { // Ctrl+C mid-request too
		os.Exit(130)
	}
	return err
}

// exitOnCancel exits 130 when ctx ends, until the func it returns is called:
// main's deferred stop() cancels ctx after a successful run too.
func exitOnCancel(ctx context.Context, exit func(int)) (release func()) {
	done, gone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(gone)
		select {
		case <-ctx.Done():
			fmt.Println()
			exit(130)
		case <-done:
		}
	}()
	return func() {
		close(done)
		<-gone // the watcher has stopped before ctx can end
	}
}

// folderCmd is `gateway jellyfin folder`: host folders mounted into the Docker Jellyfin (#431).
func folderCmd(ctx context.Context, compose string) *cobra.Command {
	var yes bool
	f := func() jellyfin.FolderIO {
		return jellyfin.FolderIO{File: compose, Yes: yes, In: os.Stdin, Out: os.Stdout}
	}
	add := &cobra.Command{
		Use: "add <path>", Args: args(cobra.ExactArgs(1)),
		Short: "Mount a folder read-only into Jellyfin, under /media/",
		Long: `Mount a folder of this machine read-only into Jellyfin at /media/<name> (its
folder name unless --as), then restart Jellyfin. Pick it as a library folder in
Jellyfin's Dashboard afterwards.`,
		Example: `  gateway jellyfin folder add "D:\My Movies"
  gateway jellyfin folder add /srv/tv --as tv`,
	}
	as := add.Flags().String("as", "", "the name under /media/")
	add.RunE = func(_ *cobra.Command, a []string) error { return jellyfin.FolderAdd(ctx, f(), a[0], *as) }
	cmd := group(&cobra.Command{
		Use:   "folder",
		Short: "Mount this machine's folders into Jellyfin (list, add, remove)",
		Long: `Mount this machine's folders into the Docker Jellyfin, read-only under /media/:
edits the jellyfin service's volumes: in jellyfin-compose.yml and restarts Jellyfin.`,
		Example: `  gateway jellyfin folder list
  gateway jellyfin folder add "D:\My Movies"
  gateway jellyfin folder remove "/media/My Movies"`,
	},
		&cobra.Command{
			Use: "list", Args: none, ValidArgsFunction: noFiles,
			Short:   "List the folders mounted under /media/",
			Example: "  gateway jellyfin folder list",
			RunE:    func(*cobra.Command, []string) error { return jellyfin.FolderList(f()) },
		},
		add,
		&cobra.Command{
			Use: "remove <path|/media/name>", Args: args(cobra.ExactArgs(1)),
			Short: "Unmount a folder from Jellyfin (its files stay)",
			Long: `Unmount a folder from Jellyfin, by its path or its /media/ name, then restart
Jellyfin. Libraries using it lose its titles until it is mounted again; no file
is deleted.`,
			Example: `  gateway jellyfin folder remove "D:\My Movies"
  gateway jellyfin folder remove /media/tv`,
			RunE: func(_ *cobra.Command, a []string) error { return jellyfin.FolderRemove(ctx, f(), a[0]) },
		},
	)
	cmd.PersistentFlags().BoolVarP(&yes, "yes", "y", false, "don't ask to confirm")
	return cmd
}
