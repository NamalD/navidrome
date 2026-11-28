package persistence

import (
	"context"
	"encoding/json"

	"github.com/deluan/rest"
	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("lyrics filter", func() {
	var mr model.MediaFileRepository

	byLyrics := func(query string) []string {
		res, err := mr.(model.ResourceRepository).ReadAll(rest.QueryOptions{
			Filters: map[string]any{"lyrics": query},
		})
		Expect(err).ToNot(HaveOccurred())
		var ids []string
		for _, f := range res.(model.MediaFiles) {
			ids = append(ids, f.ID)
		}
		return ids
	}

	lyricsOf := func(lines ...string) string {
		list := model.LyricList{{Lang: "eng"}}
		for _, line := range lines {
			list[0].Line = append(list[0].Line, model.Line{Value: line})
		}
		data, err := json.Marshal(list)
		Expect(err).ToNot(HaveOccurred())
		return string(data)
	}

	BeforeEach(func() {
		ctx := request.WithUser(log.NewContext(context.TODO()), model.User{ID: "userid"})
		mr = NewMediaFileRepository(ctx, GetDBXBuilder())
	})

	It("finds a song by words of its lyrics, wherever they are", func() {
		Expect(byLyrics("set of lyrics")).To(Equal([]string{songAntennaWithLyrics.ID}))
		Expect(byLyrics("lyrics this")).To(Equal([]string{songAntennaWithLyrics.ID}))
	})

	It("matches the word being typed by its beginning", func() {
		Expect(byLyrics("this is a set of lyr")).To(Equal([]string{songAntennaWithLyrics.ID}))
	})

	It("ignores case, accents and punctuation", func() {
		Expect(byLyrics("LYRICS, sét!")).To(Equal([]string{songAntennaWithLyrics.ID}))
	})

	It("does not match titles, artists or the JSON around the lines", func() {
		Expect(byLyrics("antenna")).To(BeEmpty())
		Expect(byLyrics("kraftwerk")).To(BeEmpty())
		Expect(byLyrics("synced")).To(BeEmpty())
		Expect(byLyrics("xxx")).To(BeEmpty())
	})

	It("finds nothing when a word is missing or the query is blank", func() {
		Expect(byLyrics("set of poems")).To(BeEmpty())
		Expect(byLyrics("  ")).To(BeEmpty())
	})

	Context("when a song is added, changed and removed", func() {
		var song model.MediaFile

		BeforeEach(func() {
			song = mf(model.MediaFile{ID: "lyrics-search-1", Title: "Untitled", LibraryID: 1,
				Lyrics: lyricsOf("Hold me closer, tiny dancer", "Count the headlights on the highway")})
			Expect(mr.Put(&song)).To(Succeed())
			DeferCleanup(func() { _ = mr.Delete(song.ID) })
		})

		It("indexes every line of the new song", func() {
			Expect(byLyrics("tiny dancer")).To(Equal([]string{song.ID}))
			Expect(byLyrics("headlights highway")).To(Equal([]string{song.ID}))
		})

		It("follows a change of lyrics", func() {
			song.Lyrics = lyricsOf("Rocket man, burning out his fuse up here alone")
			Expect(mr.Put(&song)).To(Succeed())

			Expect(byLyrics("tiny dancer")).To(BeEmpty())
			Expect(byLyrics("rocket man")).To(Equal([]string{song.ID}))
		})

		It("forgets lyrics that were removed", func() {
			song.Lyrics = "[]"
			Expect(mr.Put(&song)).To(Succeed())

			Expect(byLyrics("tiny dancer")).To(BeEmpty())
		})

		It("forgets a deleted song", func() {
			Expect(mr.Delete(song.ID)).To(Succeed())

			Expect(byLyrics("tiny dancer")).To(BeEmpty())
		})
	})

	Context("with lyrics fetched for a song without any in its tags", func() {
		var song model.MediaFile
		var fetched model.FetchedLyricsRepository

		BeforeEach(func() {
			ctx := request.WithUser(log.NewContext(context.TODO()), model.User{ID: "userid"})
			fetched = NewFetchedLyricsRepository(ctx, GetDBXBuilder())
			song = mf(model.MediaFile{ID: "lyrics-search-fetched", Title: "Untitled", LibraryID: 1, Lyrics: "[]"})
			Expect(mr.Put(&song)).To(Succeed())
			DeferCleanup(func() { _ = mr.Delete(song.ID) })
			Expect(fetched.Put(song.ID, model.LyricList{{Lang: "eng", Line: []model.Line{
				{Value: "Through the high wire"}, {Value: "Every single night"},
			}}})).To(Succeed())
		})

		It("finds the song by them", func() {
			Expect(byLyrics("high wire")).To(Equal([]string{song.ID}))
		})

		It("returns them with the song", func() {
			res, err := mr.(model.ResourceRepository).ReadAll(rest.QueryOptions{
				Filters: map[string]any{"lyrics": "high wire"},
			})
			Expect(err).ToNot(HaveOccurred())
			Expect(res.(model.MediaFiles)[0].FetchedLyrics).To(ContainSubstring("Through the high wire"))
		})

		It("follows a new fetch", func() {
			Expect(fetched.Put(song.ID, nil)).To(Succeed())
			Expect(byLyrics("high wire")).To(BeEmpty())
		})

		It("prefers lyrics that appear in the tags later", func() {
			song.Lyrics = lyricsOf("Now embedded in the file")
			Expect(mr.Put(&song)).To(Succeed())
			Expect(byLyrics("high wire")).To(BeEmpty())
			Expect(byLyrics("embedded file")).To(Equal([]string{song.ID}))

			song.Lyrics = "[]"
			Expect(mr.Put(&song)).To(Succeed())
			Expect(byLyrics("high wire")).To(Equal([]string{song.ID}))
		})

		It("forgets them when the song is deleted", func() {
			Expect(mr.Delete(song.ID)).To(Succeed())
			Expect(byLyrics("high wire")).To(BeEmpty())
			var count int
			Expect(GetDBXBuilder().NewQuery("SELECT count(*) FROM media_file_fetched_lyrics WHERE media_file_id = {:id}").
				Bind(map[string]any{"id": song.ID}).Row(&count)).To(Succeed())
			Expect(count).To(BeZero())
		})
	})

	It("matches CJK lyrics by substring", func() {
		song := mf(model.MediaFile{ID: "lyrics-search-cjk", Title: "Untitled", LibraryID: 1,
			Lyrics: lyricsOf("残酷な天使のように")})
		Expect(mr.Put(&song)).To(Succeed())
		DeferCleanup(func() { _ = mr.Delete(song.ID) })

		Expect(byLyrics("天使")).To(Equal([]string{song.ID}))
	})
})
