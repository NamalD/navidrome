package lyrics_test

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/conf/configtest"
	"github.com/navidrome/navidrome/core/lyrics"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/tests"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

// fakeLyrics answers GetLyrics from a map of song id to lyrics or error, and counts the calls.
type fakeLyrics struct {
	mu     sync.Mutex
	result map[string]model.LyricList
	fail   map[string]error
	calls  map[string]int
	onCall func()
}

func (f *fakeLyrics) GetLyrics(_ context.Context, mf *model.MediaFile) (model.LyricList, error) {
	f.mu.Lock()
	f.calls[mf.ID]++
	onCall := f.onCall
	f.mu.Unlock()
	if onCall != nil {
		onCall()
	}
	return f.result[mf.ID], f.fail[mf.ID]
}

func (f *fakeLyrics) GetLyricsByArtistTitle(context.Context, string, string) (model.LyricList, error) {
	return nil, nil
}

var _ = Describe("Fetcher", func() {
	var (
		ctx     context.Context
		ds      *tests.MockDataStore
		store   *tests.MockFetchedLyricsRepo
		src     *fakeLyrics
		loader  *mockPluginLoader
		fetcher *lyrics.Fetcher
	)
	found := model.LyricList{{Lang: "eng", Line: []model.Line{{Value: "Through the high wire"}}}}

	BeforeEach(func() {
		DeferCleanup(configtest.SetupConfig())
		conf.Server.LyricsPriority = ".lrc,embedded,test-lyrics-plugin"
		ctx = context.Background()
		store = &tests.MockFetchedLyricsRepo{Data: map[string]model.LyricList{}, PendingSongs: model.MediaFiles{
			{ID: "1", Path: "a.flac"}, {ID: "2", Path: "b.flac"}, {ID: "3", Path: "c.flac"},
		}}
		ds = &tests.MockDataStore{MockedFetchedLyrics: store}
		src = &fakeLyrics{
			result: map[string]model.LyricList{"1": found},
			fail:   map[string]error{},
			calls:  map[string]int{},
		}
		loader = &mockPluginLoader{}
		fetcher = lyrics.NewFetcher(ds, src, loader)
		fetcher.Delay = 0
		fetcher.PollInterval = time.Millisecond
	})

	It("stores what each pending song's sources return, nothing found included", func() {
		Expect(fetcher.Run(ctx)).To(Succeed())

		l, ok := store.Get("1")
		Expect(ok).To(BeTrue())
		Expect(l).To(Equal(found))
		l, ok = store.Get("2")
		Expect(ok).To(BeTrue())
		Expect(l).To(BeEmpty())
	})

	It("tries each song once per run, even if the store keeps reporting it", func() {
		Expect(fetcher.Run(ctx)).To(Succeed())

		Expect(src.calls).To(Equal(map[string]int{"1": 1, "2": 1, "3": 1}))
	})

	It("records a failed fetch as not found, and goes on with the next song", func() {
		src.result["2"] = found
		src.fail["2"] = errors.New("no lyrics found from any provider")

		Expect(fetcher.Run(ctx)).To(Succeed())

		l, ok := store.Get("2")
		Expect(ok).To(BeTrue())
		Expect(l).To(BeEmpty())
		_, ok = store.Get("3")
		Expect(ok).To(BeTrue())
	})

	It("fetches nothing while a lyrics plugin is not loaded", func() {
		loader.notFound = true

		Expect(fetcher.SourcesReady()).To(BeFalse())
		Expect(fetcher.Run(ctx)).To(Succeed())
		Expect(src.calls).To(BeEmpty())
	})

	It("needs no plugin when none is a source", func() {
		conf.Server.LyricsPriority = ".lrc,embedded"

		Expect(lyrics.NewFetcher(ds, src, nil).SourcesReady()).To(BeTrue())
	})

	It("waits while paused", func() {
		paused := true
		var mu sync.Mutex
		fetcher.Pause = func() bool { mu.Lock(); defer mu.Unlock(); return paused }
		done := make(chan error)
		go func() { done <- fetcher.Run(ctx) }()

		Consistently(done, 50*time.Millisecond).ShouldNot(Receive())
		Expect(store.Data).To(BeEmpty())
		mu.Lock()
		paused = false
		mu.Unlock()
		Eventually(done).Should(Receive(BeNil()))
		Expect(store.Data).To(HaveLen(3))
	})

	It("stops when its context ends", func() {
		ctx, cancel := context.WithCancel(ctx)
		src.onCall = cancel

		Expect(fetcher.Run(ctx)).To(Succeed())
		Expect(src.calls).To(HaveLen(1))
		Expect(store.Data).To(BeEmpty())
	})

	It("returns at once while another run is going", func() {
		release := make(chan struct{})
		src.onCall = func() { <-release }
		done := make(chan error)
		go func() { done <- fetcher.Run(ctx) }()
		Eventually(func() int { src.mu.Lock(); defer src.mu.Unlock(); return len(src.calls) }).Should(Equal(1))

		Expect(fetcher.Run(ctx)).To(Succeed())
		close(release)
		Eventually(done).Should(Receive(BeNil()))
		Expect(src.calls["1"]).To(Equal(1))
	})
})
