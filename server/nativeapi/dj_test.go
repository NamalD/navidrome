package nativeapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/conf/configtest"
	"github.com/navidrome/navidrome/core/auth"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/server"
	"github.com/navidrome/navidrome/tests"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("DJ analysis endpoints", func() {
	var router http.Handler
	var ds *tests.MockDataStore
	var userToken string
	analysis := `{"schema":1,"bpm":120.5,"key":{"camelot":"8A"},"embedding":[0.1,0.2]}`

	upload := func(method, path, body, key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	newRouter := func() {
		router = server.JWTVerifier(New(ds, nil, nil, nil, tests.NewMockLibraryService(), tests.NewMockUserService(), nil, nil, nil, nil, nil, nil))
	}

	BeforeEach(func() {
		DeferCleanup(configtest.SetupConfig())
		conf.Server.SessionTimeout = time.Minute
		conf.Server.EnableSharing = false
		conf.Server.DJ.UploadKey = "s3cret"

		userRepo := tests.CreateMockUserRepo()
		mfRepo := tests.CreateMockMediaFileRepo()
		mfRepo.SetData(model.MediaFiles{{ID: "song-1", Title: "One"}})
		ds = &tests.MockDataStore{MockedUser: userRepo, MockedProperty: &tests.MockedPropertyRepo{}, MockedMediaFile: mfRepo}
		auth.Init(ds)
		user := model.User{ID: "user-1", UserName: "user", NewPassword: "userpass"}
		Expect(userRepo.Put(&user)).To(Succeed())
		var err error
		userToken, err = auth.CreateToken(&user)
		Expect(err).ToNot(HaveOccurred())
		newRouter()
	})

	It("stores an upload and lists its checksum", func() {
		w := upload(http.MethodPut, "/dj/upload/song-1", analysis, "s3cret")
		Expect(w.Code).To(Equal(http.StatusNoContent), w.Body.String())

		w = upload(http.MethodGet, "/dj/upload/", "", "s3cret")
		Expect(w.Code).To(Equal(http.StatusOK), w.Body.String())
		var sums map[string]string
		Expect(json.Unmarshal(w.Body.Bytes(), &sums)).To(Succeed())
		Expect(sums).To(HaveKey("song-1"))
		Expect(sums["song-1"]).To(HaveLen(64))
	})

	It("refuses uploads without the key or with a wrong one", func() {
		Expect(upload(http.MethodPut, "/dj/upload/song-1", analysis, "").Code).To(Equal(http.StatusUnauthorized))
		Expect(upload(http.MethodPut, "/dj/upload/song-1", analysis, "wrong").Code).To(Equal(http.StatusUnauthorized))
		Expect(ds.DJAnalysis(nil).Checksums()).To(BeEmpty())
	})

	It("has no upload endpoints when no key is set", func() {
		conf.Server.DJ.UploadKey = ""
		newRouter()
		// An empty key must not match an empty bearer token.
		Expect(upload(http.MethodPut, "/dj/upload/song-1", analysis, "").Code).ToNot(Equal(http.StatusNoContent))
		Expect(ds.DJAnalysis(nil).Checksums()).To(BeEmpty())
	})

	It("rejects unknown songs and documents without a schema", func() {
		Expect(upload(http.MethodPut, "/dj/upload/nope", analysis, "s3cret").Code).To(Equal(http.StatusNotFound))
		Expect(upload(http.MethodPut, "/dj/upload/song-1", `{"bpm":1}`, "s3cret").Code).To(Equal(http.StatusBadRequest))
		Expect(upload(http.MethodPut, "/dj/upload/song-1", `not json`, "s3cret").Code).To(Equal(http.StatusBadRequest))
		big := `{"schema":1,"x":"` + strings.Repeat("a", maxDJAnalysisSize) + `"}`
		Expect(upload(http.MethodPut, "/dj/upload/song-1", big, "s3cret").Code).To(Equal(http.StatusRequestEntityTooLarge))
	})

	It("serves the analysis to a logged-in user without the embedding", func() {
		Expect(upload(http.MethodPut, "/dj/upload/song-1", analysis, "s3cret").Code).To(Equal(http.StatusNoContent))

		w := httptest.NewRecorder()
		router.ServeHTTP(w, createAuthenticatedRequest(http.MethodGet, "/dj/analysis/song-1", &bytes.Buffer{}, userToken))
		Expect(w.Code).To(Equal(http.StatusOK), w.Body.String())
		var doc map[string]any
		Expect(json.Unmarshal(w.Body.Bytes(), &doc)).To(Succeed())
		Expect(doc).To(HaveKeyWithValue("bpm", 120.5))
		Expect(doc).ToNot(HaveKey("embedding"))

		w = httptest.NewRecorder()
		router.ServeHTTP(w, createAuthenticatedRequest(http.MethodGet, "/dj/analysis/song-1", &bytes.Buffer{}, ""))
		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("plans the next song among the ones the user can see", func() {
		mf := ds.MockedMediaFile.(*tests.MockMediaFileRepo)
		mf.SetData(model.MediaFiles{{ID: "song-1", Title: "One"}, {ID: "song-2", Title: "Two"}})
		steady := func(title string, bpm float64) string {
			beat := 60 / bpm
			var beats, downbeats []float64
			for i := range 256 {
				beats = append(beats, 0.5+float64(i)*beat)
				if i%4 == 0 {
					downbeats = append(downbeats, 0.5+float64(i)*beat)
				}
			}
			doc, _ := json.Marshal(map[string]any{
				"schema": 1, "duration": 256*beat + 2, "bpm": bpm, "beats": beats, "downbeats": downbeats,
				"phrases": []int{0, 16, 32, 48}, "key": map[string]any{"pitch_class": 0, "confidence": "high"},
				"embedding": []float64{1, 0.1}, "source": map[string]any{"artist": "A", "title": title},
			})
			return string(doc)
		}
		repo := ds.DJAnalysis(nil)
		Expect(repo.Put("song-1", []byte(steady("One", 124)))).To(Succeed())
		Expect(repo.Put("song-2", []byte(steady("Two", 126)))).To(Succeed())
		// Analysed, but not in the library any more (or not visible to this user).
		Expect(repo.Put("gone", []byte(steady("Gone", 124)))).To(Succeed())

		get := func(query string) *httptest.ResponseRecorder {
			w := httptest.NewRecorder()
			router.ServeHTTP(w, createAuthenticatedRequest(http.MethodGet, "/dj/next?"+query, &bytes.Buffer{}, userToken))
			return w
		}
		for range 10 {
			w := get("current=song-1&rate=1")
			Expect(w.Code).To(Equal(http.StatusOK), w.Body.String())
			var plan struct {
				SongID     string `json:"songId"`
				Transition struct {
					Type string  `json:"type"`
					Rate float64 `json:"rate"`
				} `json:"transition"`
			}
			Expect(json.Unmarshal(w.Body.Bytes(), &plan)).To(Succeed())
			Expect(plan.SongID).To(Equal("song-2"))
			Expect(plan.Transition.Type).To(Equal("blend"))
			Expect(plan.Transition.Rate).To(BeNumerically("~", 124.0/126, 1e-9))
		}
		Expect(get("current=song-1&exclude=song-2").Code).To(Equal(http.StatusNotFound))
		Expect(get("current=nope").Code).To(Equal(http.StatusNotFound))
		Expect(get("").Code).To(Equal(http.StatusBadRequest))
		Expect(get("current=song-1&rate=abc").Code).To(Equal(http.StatusBadRequest))
	})

	It("answers 404 for a song that has not been analysed", func() {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, createAuthenticatedRequest(http.MethodGet, "/dj/analysis/song-1", &bytes.Buffer{}, userToken))
		Expect(w.Code).To(Equal(http.StatusNotFound))
	})
})
