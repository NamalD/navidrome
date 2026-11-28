package main

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/NamalD/navidrome/contrib/nowplaylist/lastfm"
	"github.com/NamalD/navidrome/contrib/nowplaylist/store"
)

// lateScrobbleWindow is how far before the last sync a run looks again. Last.fm accepts scrobbles timestamped up
// to two weeks in the past (a phone that was offline, say), and they would fall before a plain "since last sync".
const lateScrobbleWindow = 14 * 24 * time.Hour

// syncHistory copies a user's Last.fm plays into the store: everything on the first run, then the plays since the
// last finished run (less lateScrobbleWindow). The upper bound is fixed when the run starts, so plays scrobbled
// while it pages through history don't shift the pages under it. A run that stops part way is safe to repeat:
// SyncedThrough only moves once every page is stored, and stored plays are skipped.
func syncHistory(ctx context.Context, lfm *lastfm.Client, db *store.Store, user string, now time.Time, log io.Writer) (int, error) {
	since, err := db.SyncedThrough(ctx)
	if err != nil {
		return 0, err
	}
	q := lastfm.RecentTracksQuery{User: user, To: now, Limit: lastfm.MaxPageSize}
	if !since.IsZero() {
		q.From = since.Add(-lateScrobbleWindow)
	}

	added := 0
	for q.Page = 1; ; q.Page++ {
		page, err := lfm.RecentTracks(ctx, q)
		if err != nil {
			return added, fmt.Errorf("page %d: %w", q.Page, err)
		}
		n, err := db.Add(ctx, page.Scrobbles)
		if err != nil {
			return added, err
		}
		added += n
		if page.TotalPages > 1 && (q.Page%25 == 0 || q.Page == page.TotalPages) {
			fmt.Fprintf(log, "page %d/%d, %d new so far\n", q.Page, page.TotalPages, added)
		}
		if q.Page >= page.TotalPages || len(page.Scrobbles) == 0 {
			break
		}
	}
	return added, db.SetSyncedThrough(ctx, now)
}
