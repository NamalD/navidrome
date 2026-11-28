package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/NamalD/navidrome/contrib/nowplaylist/lastfm"
	"github.com/NamalD/navidrome/contrib/nowplaylist/store"
)

// fakeLastfm serves user.getrecenttracks over a list of plays, newest first, honouring from, to, page and limit
// the way Last.fm does.
type fakeLastfm struct {
	mu       sync.Mutex
	plays    []int64 // Unix seconds
	requests []map[string]string
}

func (f *fakeLastfm) add(uts ...int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.plays = append(f.plays, uts...)
}

func (f *fakeLastfm) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	q := r.URL.Query()
	f.requests = append(f.requests, map[string]string{"from": q.Get("from"), "to": q.Get("to"), "page": q.Get("page")})
	num := func(k string, def int64) int64 {
		if v := q.Get(k); v != "" {
			n, _ := strconv.ParseInt(v, 10, 64)
			return n
		}
		return def
	}
	from, to := num("from", 0), num("to", 1<<62)
	page, limit := int(num("page", 1)), int(num("limit", 50))

	var sel []int64
	for _, p := range f.plays {
		if p >= from && p <= to {
			sel = append(sel, p)
		}
	}
	sort.Slice(sel, func(i, j int) bool { return sel[i] > sel[j] })
	totalPages := (len(sel) + limit - 1) / limit
	var tracks []map[string]any
	for i := (page - 1) * limit; i < len(sel) && i < page*limit; i++ {
		tracks = append(tracks, map[string]any{
			"name": "t" + strconv.FormatInt(sel[i], 10), "artist": map[string]string{"#text": "a"},
			"album": map[string]string{"#text": ""}, "date": map[string]string{"uts": strconv.FormatInt(sel[i], 10)},
		})
	}
	json.NewEncoder(w).Encode(map[string]any{"recenttracks": map[string]any{
		"track": tracks,
		"@attr": map[string]string{"page": strconv.Itoa(page), "totalPages": strconv.Itoa(totalPages), "total": strconv.Itoa(len(sel))},
	}})
}

func setup(t *testing.T) (*fakeLastfm, *lastfm.Client, *store.Store) {
	t.Helper()
	fake := &fakeLastfm{}
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	c := lastfm.NewClient("key")
	c.BaseURL = srv.URL + "/"
	c.MinInterval = 0
	db, err := store.Open(filepath.Join(t.TempDir(), "h.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return fake, c, db
}

func TestSyncFetchesEverythingThenOnlyRecentPlays(t *testing.T) {
	ctx := context.Background()
	fake, c, db := setup(t)
	day := int64(24 * 60 * 60)
	base := int64(1_700_000_000)
	for i := int64(0); i < 450; i++ { // three pages of 200
		fake.add(base + i*60)
	}
	first := time.Unix(base+100*day, 0)

	added, err := syncHistory(ctx, c, db, "u", first, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if added != 450 {
		t.Fatalf("first sync added %d, want 450", added)
	}
	if len(fake.requests) != 3 || fake.requests[0]["from"] != "" {
		t.Fatalf("first sync requests = %v", fake.requests)
	}

	// A play scrobbled late (timestamped a week before the first sync) and two new ones.
	fake.add(first.Unix()-7*day, first.Unix()+10, first.Unix()+20)
	fake.requests = nil
	second := first.Add(time.Hour)
	added, err = syncHistory(ctx, c, db, "u", second, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if added != 3 {
		t.Errorf("second sync added %d, want 3", added)
	}
	wantFrom := strconv.FormatInt(first.Add(-lateScrobbleWindow).Unix(), 10)
	if len(fake.requests) != 1 || fake.requests[0]["from"] != wantFrom || fake.requests[0]["to"] != strconv.FormatInt(second.Unix(), 10) {
		t.Errorf("second sync requests = %v, want one from %s", fake.requests, wantFrom)
	}
	if n, _ := db.Count(ctx); n != 453 {
		t.Errorf("stored %d, want 453", n)
	}
}

func TestInterruptedSyncIsRetriedFromTheStart(t *testing.T) {
	ctx := context.Background()
	fake, c, db := setup(t)
	for i := int64(0); i < 300; i++ {
		fake.add(1_700_000_000 + i)
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := syncHistory(cctx, c, db, "u", time.Unix(1_800_000_000, 0), io.Discard); err == nil {
		t.Fatal("expected the cancelled sync to fail")
	}
	if since, _ := db.SyncedThrough(ctx); !since.IsZero() {
		t.Fatalf("SyncedThrough moved to %v after a failed sync", since)
	}
	if _, err := syncHistory(ctx, c, db, "u", time.Unix(1_800_000_000, 0), io.Discard); err != nil {
		t.Fatal(err)
	}
	if n, _ := db.Count(ctx); n != 300 {
		t.Errorf("stored %d, want 300", n)
	}
}
