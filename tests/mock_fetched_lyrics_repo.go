package tests

import (
	"slices"
	"sync"
	"time"

	"github.com/navidrome/navidrome/model"
)

// MockFetchedLyricsRepo records what was Put, by media file id. Pending returns the songs in PendingSongs
// that are not excluded, without looking at what was Put, as a stale or failing query would.
type MockFetchedLyricsRepo struct {
	mu           sync.Mutex
	Data         map[string]model.LyricList
	PendingSongs model.MediaFiles
	Err          error
}

func (m *MockFetchedLyricsRepo) Pending(_ time.Time, max int, exclude []string) (model.MediaFiles, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var res model.MediaFiles
	for _, mf := range m.PendingSongs {
		if len(res) < max && !slices.Contains(exclude, mf.ID) {
			res = append(res, mf)
		}
	}
	return res, nil
}

func (m *MockFetchedLyricsRepo) Put(mediaFileID string, lyrics model.LyricList) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Err != nil {
		return m.Err
	}
	m.Data[mediaFileID] = lyrics
	return nil
}

func (m *MockFetchedLyricsRepo) Get(mediaFileID string) (model.LyricList, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.Data[mediaFileID]
	return l, ok
}
