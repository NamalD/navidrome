package djmix

import (
	"context"
	"sync"
	"time"

	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
)

// libraryTTL is how long the parsed analyses are reused before being read again, so new uploads show up.
const libraryTTL = 10 * time.Minute

// Library keeps every song's parsed analysis in memory (about 650 songs × 1280-number embeddings is ~7 MB),
// reloading it from the database at most every libraryTTL.
type Library struct {
	ds  model.DataStore
	now func() time.Time

	mu       sync.Mutex
	songs    map[string]*Analysis
	loadedAt time.Time
}

func NewLibrary(ds model.DataStore) *Library {
	return &Library{ds: ds, now: time.Now}
}

// Songs returns the analyses by song ID. Documents that don't parse, or have another schema, are left out.
func (l *Library) Songs(ctx context.Context) (map[string]*Analysis, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.songs != nil && l.now().Sub(l.loadedAt) < libraryTTL {
		return l.songs, nil
	}
	rows, err := l.ds.DJAnalysis(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	songs := make(map[string]*Analysis, len(rows))
	for _, row := range rows {
		a, err := ParseAnalysis([]byte(row.Analysis))
		if err != nil {
			log.Warn(ctx, "Skipping DJ analysis", "id", row.MediaFileID, err)
			continue
		}
		songs[row.MediaFileID] = a
	}
	l.songs, l.loadedAt = songs, l.now()
	return songs, nil
}
