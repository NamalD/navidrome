// Command nowplaylist builds Navidrome playlists from a Last.fm listening history and the time of day. It runs on
// the desktop, not in the Navidrome image. See README.md.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"time"

	"github.com/NamalD/navidrome/contrib/nowplaylist/lastfm"
	"github.com/NamalD/navidrome/contrib/nowplaylist/store"
)

const usage = `usage: nowplaylist <command>

commands:
  sync    copy new Last.fm plays into the local history and compare the count with Last.fm's
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	var err error
	switch os.Args[1] {
	case "sync":
		err = runSync(ctx)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "nowplaylist:", err)
		os.Exit(1)
	}
}

func runSync(ctx context.Context) error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	db, err := store.Open(cfg.DBPath)
	if err != nil {
		return err
	}
	defer db.Close()
	lfm := lastfm.NewClient(cfg.LastfmAPIKey)

	added, err := syncHistory(ctx, lfm, db, cfg.LastfmUser, time.Now(), os.Stderr)
	if err != nil {
		return err
	}
	stored, err := db.Count(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("%d new plays, %d stored in %s\n", added, stored, cfg.DBPath)

	// Last.fm's own total, as a check. It can run a little ahead of the history when plays are scrobbled during
	// the sync, and behind when two plays of one track share a second (stored once).
	total, err := lfm.PlayCount(ctx, cfg.LastfmUser)
	if err != nil {
		return fmt.Errorf("checking the total: %w", err)
	}
	fmt.Printf("Last.fm reports %d scrobbles\n", total)
	return nil
}
