package lyrics

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
)

const (
	// fetchRetryMissingAfter is how long a song whose lyrics were not found waits to be tried again. A
	// failed fetch counts as not found: plugins report "no lyrics" as an error too (nd-lyrics does), and
	// retrying those every run would query the online sources for every instrumental each hour.
	fetchRetryMissingAfter = 7 * 24 * time.Hour
	fetchBatchSize         = 50
)

// Fetcher fetches, in the background, the lyrics of songs that have none in their tags from the other
// configured sources (plugins, sidecar files), and stores them so they can be searched.
type Fetcher struct {
	ds           model.DataStore
	lyrics       Lyrics
	pluginLoader PluginLoader
	running      sync.Mutex

	// Delay is the wait between two songs, to be gentle with online sources.
	Delay time.Duration
	// Pause, when set, holds a run while it reports true (e.g. during a scan, which writes to the DB).
	Pause func() bool
	// PollInterval is how often a paused run, or WaitForSources, checks again.
	PollInterval time.Duration
}

func NewFetcher(ds model.DataStore, lyrics Lyrics, pluginLoader PluginLoader) *Fetcher {
	return &Fetcher{ds: ds, lyrics: lyrics, pluginLoader: pluginLoader, Delay: time.Second, PollInterval: 5 * time.Second}
}

// pluginSources lists the plugins named in conf.Server.LyricsPriority.
func pluginSources() []string {
	var names []string
	for pattern := range strings.SplitSeq(conf.Server.LyricsPriority, ",") {
		pattern = strings.TrimSpace(pattern)
		if pattern != "" && !strings.EqualFold(pattern, "embedded") && !strings.HasPrefix(pattern, ".") {
			names = append(names, pattern)
		}
	}
	return names
}

// SourcesReady reports whether every plugin named as a lyrics source is loaded. Fetching before then
// would record the songs as having no lyrics.
func (f *Fetcher) SourcesReady() bool {
	for _, name := range pluginSources() {
		if f.pluginLoader == nil {
			return false
		}
		if _, ok := f.pluginLoader.LoadLyricsProvider(name); !ok {
			return false
		}
	}
	return true
}

// WaitForSources waits until SourcesReady, for at most timeout, and reports whether they are.
func (f *Fetcher) WaitForSources(ctx context.Context, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for !f.SourcesReady() {
		if time.Now().After(deadline) || !sleep(ctx, f.PollInterval) {
			return false
		}
	}
	return true
}

// Run fetches the lyrics of every song that needs them, one song at a time, and returns when none is
// left or ctx ends. A song is tried at most once per run, so a source that keeps failing, or a song the
// store keeps reporting, cannot keep a run going. If a run is already going, Run returns at once.
func (f *Fetcher) Run(ctx context.Context) error {
	if !f.running.TryLock() {
		return nil
	}
	defer f.running.Unlock()
	if !f.SourcesReady() {
		log.Warn(ctx, "Not fetching lyrics in the background: a lyrics plugin is not loaded", "sources", conf.Server.LyricsPriority)
		return nil
	}

	var tried []string
	found := 0
	defer func() {
		if len(tried) > 0 {
			log.Info(ctx, "Fetched lyrics in the background", "songs", len(tried), "found", found)
		}
	}()
	for {
		songs, err := f.ds.FetchedLyrics(ctx).Pending(time.Now().Add(-fetchRetryMissingAfter), fetchBatchSize, tried)
		if err != nil {
			return err
		}
		if len(songs) == 0 {
			return nil
		}
		for i := range songs {
			mf := &songs[i]
			for f.Pause != nil && f.Pause() {
				if !sleep(ctx, f.PollInterval) {
					return nil
				}
			}
			tried = append(tried, mf.ID)
			list, err := f.lyrics.GetLyrics(ctx, mf)
			if ctx.Err() != nil {
				return nil
			}
			if err != nil {
				log.Debug(ctx, "No lyrics fetched", "file", mf.Path, err)
				list = nil
			}
			if err := f.ds.FetchedLyrics(ctx).Put(mf.ID, list); err != nil {
				return err
			}
			if len(list) > 0 {
				found++
			}
			if !sleep(ctx, f.Delay) {
				return nil
			}
		}
	}
}

// sleep waits for d, and reports false if ctx ended first.
func sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}
