package persistence

import (
	"context"

	"github.com/deluan/rest"
	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("REST lists filtered by a search", func() {
	var mr model.MediaFileRepository

	titles := func(options rest.QueryOptions) []string {
		res, err := mr.(model.ResourceRepository).ReadAll(options)
		Expect(err).ToNot(HaveOccurred())
		var ids []string
		for _, f := range res.(model.MediaFiles) {
			ids = append(ids, f.ID)
		}
		return ids
	}

	BeforeEach(func() {
		ctx := request.WithUser(log.NewContext(context.TODO()), model.User{ID: "userid", IsAdmin: true})
		mr = NewMediaFileRepository(ctx, GetDBXBuilder())
		// Added in the opposite order of their relevance, so the table order is the wrong one
		for _, s := range []model.MediaFile{
			{ID: "rel-1", Title: "Lovers in the Midnight Hour", Lyrics: `[{"lang":"eng","line":[{"value":"once upon a long time, midnight came and went and nothing else happened at all"}]}]`},
			{ID: "rel-2", Title: "Midnight", Lyrics: `[{"lang":"eng","line":[{"value":"midnight, midnight"}]}]`},
		} {
			s := mf(s)
			s.LibraryID = 1
			Expect(mr.Put(&s)).To(Succeed())
			DeferCleanup(func() { _ = mr.Delete(s.ID) })
		}
	})

	It("lists the best title matches first when no order is asked for", func() {
		Expect(titles(rest.QueryOptions{Filters: map[string]any{"title": "midnight"}})).To(Equal([]string{"rel-2", "rel-1"}))
	})

	It("lists the best lyrics matches first when no order is asked for", func() {
		Expect(titles(rest.QueryOptions{Filters: map[string]any{"lyrics": "midnight"}})).To(Equal([]string{"rel-2", "rel-1"}))
	})

	It("keeps the order asked for", func() {
		opts := rest.QueryOptions{Sort: "id", Order: "desc", Filters: map[string]any{"title": "midnight"}}
		Expect(titles(opts)).To(Equal([]string{"rel-2", "rel-1"}))
		opts.Order = "asc"
		Expect(titles(opts)).To(Equal([]string{"rel-1", "rel-2"}))
	})

	It("pages through the ranked matches", func() {
		opts := rest.QueryOptions{Max: 1, Offset: 1, Filters: map[string]any{"title": "midnight"}}
		Expect(titles(opts)).To(Equal([]string{"rel-1"}))
	})

	It("applies the other filters too", func() {
		opts := rest.QueryOptions{Filters: map[string]any{"title": "midnight", "id": "rel-1"}}
		Expect(titles(opts)).To(Equal([]string{"rel-1"}))
	})
})
