package persistence

import (
	"context"
	"time"

	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("FetchedLyricsRepository", func() {
	var repo model.FetchedLyricsRepository
	var mr model.MediaFileRepository
	weekAgo := func() time.Time { return time.Now().Add(-7 * 24 * time.Hour) }
	found := model.LyricList{{Lang: "eng", Line: []model.Line{{Value: "Every single night"}}}}

	pendingIDs := func(exclude ...string) []string {
		songs, err := repo.Pending(weekAgo(), 1000, exclude)
		Expect(err).ToNot(HaveOccurred())
		var ids []string
		for _, s := range songs {
			ids = append(ids, s.ID)
		}
		return ids
	}

	BeforeEach(func() {
		ctx := request.WithUser(log.NewContext(context.TODO()), model.User{ID: "userid"})
		repo = NewFetchedLyricsRepository(ctx, GetDBXBuilder())
		mr = NewMediaFileRepository(ctx, GetDBXBuilder())
		for _, s := range []model.MediaFile{
			{ID: "fetch-1", Title: "One", Lyrics: "[]"},
			{ID: "fetch-2", Title: "Two", Lyrics: "[]"},
			{ID: "fetch-missing", Title: "Gone", Lyrics: "[]", Missing: true},
		} {
			s := mf(s)
			s.LibraryID = 1
			Expect(mr.Put(&s)).To(Succeed())
			DeferCleanup(func() { _ = mr.Delete(s.ID) })
		}
	})

	It("lists present songs without lyrics in their tags, and not others", func() {
		ids := pendingIDs()
		Expect(ids).To(ContainElements("fetch-1", "fetch-2"))
		Expect(ids).ToNot(ContainElement("fetch-missing"))
		Expect(ids).ToNot(ContainElement(songAntennaWithLyrics.ID))
	})

	It("leaves out excluded songs", func() {
		Expect(pendingIDs("fetch-1")).ToNot(ContainElement("fetch-1"))
	})

	It("leaves out songs once fetched, found or not", func() {
		Expect(repo.Put("fetch-1", found)).To(Succeed())
		Expect(repo.Put("fetch-2", nil)).To(Succeed())

		Expect(pendingIDs()).ToNot(ContainElements("fetch-1"))
		Expect(pendingIDs()).ToNot(ContainElements("fetch-2"))
	})

	It("lists a song not found again a week later", func() {
		Expect(repo.Put("fetch-2", nil)).To(Succeed())
		_, err := GetDBXBuilder().NewQuery("UPDATE media_file_fetched_lyrics SET fetched_at = {:t} WHERE media_file_id = 'fetch-2'").
			Bind(map[string]any{"t": time.Now().Add(-8 * 24 * time.Hour)}).Execute()
		Expect(err).ToNot(HaveOccurred())
		_, err = GetDBXBuilder().NewQuery("UPDATE media_file SET updated_at = {:t} WHERE id = 'fetch-2'").
			Bind(map[string]any{"t": time.Now().Add(-9 * 24 * time.Hour)}).Execute()
		Expect(err).ToNot(HaveOccurred())

		Expect(pendingIDs()).To(ContainElement("fetch-2"))
	})

	It("lists a song again once it changed after the fetch", func() {
		Expect(repo.Put("fetch-1", found)).To(Succeed())
		_, err := GetDBXBuilder().NewQuery("UPDATE media_file SET updated_at = {:t} WHERE id = 'fetch-1'").
			Bind(map[string]any{"t": time.Now().Add(time.Minute)}).Execute()
		Expect(err).ToNot(HaveOccurred())

		Expect(pendingIDs()).To(ContainElement("fetch-1"))
	})
})
