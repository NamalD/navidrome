package nativeapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/conf/configtest"
	"github.com/navidrome/navidrome/core/auth"
	"github.com/navidrome/navidrome/core/downloader"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/server"
	"github.com/navidrome/navidrome/tests"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

type fakeDownloader struct {
	enabled bool
	err     error
	started []downloader.Request
}

func (f *fakeDownloader) Enabled() bool { return f.enabled }

func (f *fakeDownloader) Search(_ context.Context, query string) ([]downloader.Result, error) {
	return []downloader.Result{{Title: "Found " + query, Artist: "Geese", URL: "https://example.com/album/1"}}, f.err
}

func (f *fakeDownloader) Jobs(context.Context) ([]downloader.Job, error) {
	return []downloader.Job{{ID: "j1", Status: downloader.StatusRunning, TracksTotal: 11, TracksDone: 4}}, f.err
}

func (f *fakeDownloader) Start(_ context.Context, req downloader.Request) (*downloader.Job, error) {
	if !strings.HasPrefix(req.URL, "https://") {
		return nil, downloader.ErrInvalidURL
	}
	if f.err != nil {
		return nil, f.err
	}
	f.started = append(f.started, req)
	return &downloader.Job{ID: "j2", URL: req.URL, Title: req.Title, Status: downloader.StatusQueued}, nil
}

var _ = Describe("Downloader Endpoints", func() {
	var router http.Handler
	var ds model.DataStore
	var dl *fakeDownloader
	var adminToken, userToken string

	serve := func(method, path, body, token string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, createAuthenticatedRequest(method, path, bytes.NewBufferString(body), token))
		return w
	}

	newRouter := func() {
		router = server.JWTVerifier(New(ds, nil, nil, nil, tests.NewMockLibraryService(), tests.NewMockUserService(), nil, nil, nil, nil, nil, dl))
	}

	BeforeEach(func() {
		DeferCleanup(configtest.SetupConfig())
		conf.Server.SessionTimeout = time.Minute
		conf.Server.EnableSharing = false

		userRepo := tests.CreateMockUserRepo()
		ds = &tests.MockDataStore{MockedUser: userRepo, MockedProperty: &tests.MockedPropertyRepo{}}
		auth.Init(ds)

		admin := model.User{ID: "admin-1", UserName: "admin", IsAdmin: true, NewPassword: "adminpass"}
		user := model.User{ID: "user-1", UserName: "user", NewPassword: "userpass"}
		Expect(userRepo.Put(&admin)).To(Succeed())
		Expect(userRepo.Put(&user)).To(Succeed())
		var err error
		adminToken, err = auth.CreateToken(&admin)
		Expect(err).ToNot(HaveOccurred())
		userToken, err = auth.CreateToken(&user)
		Expect(err).ToNot(HaveOccurred())

		dl = &fakeDownloader{enabled: true}
		newRouter()
	})

	It("searches the catalog", func() {
		w := serve(http.MethodGet, "/downloader/search?q=getting+killed", "", adminToken)
		Expect(w.Code).To(Equal(http.StatusOK), w.Body.String())

		var results []downloader.Result
		Expect(json.Unmarshal(w.Body.Bytes(), &results)).To(Succeed())
		Expect(results).To(HaveLen(1))
		Expect(results[0].Title).To(Equal("Found getting killed"))
	})

	It("needs something to search for", func() {
		w := serve(http.MethodGet, "/downloader/search?q=+", "", adminToken)
		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("lists the downloads", func() {
		w := serve(http.MethodGet, "/downloader/job", "", adminToken)
		Expect(w.Code).To(Equal(http.StatusOK), w.Body.String())

		var jobs []downloader.Job
		Expect(json.Unmarshal(w.Body.Bytes(), &jobs)).To(Succeed())
		Expect(jobs).To(HaveLen(1))
		Expect(jobs[0].TracksDone).To(Equal(4))
	})

	It("starts a download", func() {
		w := serve(http.MethodPost, "/downloader/job", `{"url":"https://example.com/album/1","title":"Getting Killed"}`, adminToken)
		Expect(w.Code).To(Equal(http.StatusCreated), w.Body.String())

		var job downloader.Job
		Expect(json.Unmarshal(w.Body.Bytes(), &job)).To(Succeed())
		Expect(job.ID).To(Equal("j2"))
		Expect(dl.started).To(Equal([]downloader.Request{{URL: "https://example.com/album/1", Title: "Getting Killed"}}))
	})

	It("rejects a download that is not a link", func() {
		w := serve(http.MethodPost, "/downloader/job", `{"url":"--config=/etc/passwd"}`, adminToken)
		Expect(w.Code).To(Equal(http.StatusBadRequest))
		Expect(dl.started).To(BeEmpty())
	})

	It("answers 502 when the download service fails", func() {
		dl.err = errors.New("connection refused")
		Expect(serve(http.MethodGet, "/downloader/search?q=geese", "", adminToken).Code).To(Equal(http.StatusBadGateway))
		Expect(serve(http.MethodGet, "/downloader/job", "", adminToken).Code).To(Equal(http.StatusBadGateway))
		Expect(serve(http.MethodPost, "/downloader/job", `{"url":"https://example.com/album/1"}`, adminToken).Code).To(Equal(http.StatusBadGateway))
	})

	It("is only available to admins", func() {
		Expect(serve(http.MethodGet, "/downloader/job", "", userToken).Code).To(Equal(http.StatusForbidden))
		Expect(serve(http.MethodPost, "/downloader/job", `{"url":"https://example.com/album/1"}`, userToken).Code).To(Equal(http.StatusForbidden))
		Expect(dl.started).To(BeEmpty())
	})

	It("does not exist when no download service is configured", func() {
		dl.enabled = false
		newRouter()
		Expect(serve(http.MethodGet, "/downloader/job", "", adminToken).Code).To(Equal(http.StatusNotFound))
	})
})
