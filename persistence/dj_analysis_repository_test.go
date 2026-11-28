package persistence

import (
	"context"

	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("DJAnalysisRepository", func() {
	var repo model.DJAnalysisRepository
	var mr model.MediaFileRepository

	BeforeEach(func() {
		ctx := request.WithUser(log.NewContext(context.TODO()), model.User{ID: "userid", IsAdmin: true})
		repo = NewDJAnalysisRepository(ctx, GetDBXBuilder())
		mr = NewMediaFileRepository(ctx, GetDBXBuilder())
		s := mf(model.MediaFile{ID: "dj-1", Title: "One"})
		s.LibraryID = 1
		Expect(mr.Put(&s)).To(Succeed())
		DeferCleanup(func() { _ = mr.Delete(s.ID) })
	})

	It("stores, replaces and lists analyses", func() {
		Expect(repo.Put("dj-1", []byte(`{"schema":1,"bpm":120}`))).To(Succeed())
		first, err := repo.Get("dj-1")
		Expect(err).ToNot(HaveOccurred())
		Expect(first.Analysis).To(Equal(`{"schema":1,"bpm":120}`))

		Expect(repo.Put("dj-1", []byte(`{"schema":1,"bpm":121}`))).To(Succeed())
		second, err := repo.Get("dj-1")
		Expect(err).ToNot(HaveOccurred())
		Expect(second.Analysis).To(ContainSubstring("121"))
		Expect(second.Checksum).ToNot(Equal(first.Checksum))

		sums, err := repo.Checksums()
		Expect(err).ToNot(HaveOccurred())
		Expect(sums).To(HaveKeyWithValue("dj-1", second.Checksum))
		all, err := repo.GetAll()
		Expect(err).ToNot(HaveOccurred())
		Expect(all).To(ContainElement(HaveField("MediaFileID", "dj-1")))
	})

	It("reports a song without analysis as not found", func() {
		_, err := repo.Get("dj-none")
		Expect(err).To(MatchError(model.ErrNotFound))
	})
})
