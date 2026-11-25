package downloader

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"time"

	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/conf/configtest"
	"github.com/navidrome/navidrome/tests"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("Downloader", func() {
	var (
		ctx     context.Context
		scanner *tests.MockScanner
		service *httptest.Server
		mux     *http.ServeMux
		dl      *downloader
	)

	writeJSON := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}

	BeforeEach(func() {
		DeferCleanup(configtest.SetupConfig())
		ctx = context.Background()
		scanner = tests.NewMockScanner()
		mux = http.NewServeMux()
		service = httptest.NewServer(mux)
		DeferCleanup(service.Close)
		conf.Server.Downloader.URL = service.URL + "/"
		dl = New(scanner).(*downloader)
		dl.pollInterval = time.Millisecond
	})

	It("is disabled when no service is configured", func() {
		conf.Server.Downloader.URL = ""
		disabled := New(scanner)
		Expect(disabled.Enabled()).To(BeFalse())
		_, err := disabled.Search(ctx, "geese")
		Expect(err).To(MatchError(ErrDisabled))
	})

	It("searches the service's catalog", func() {
		mux.HandleFunc("GET /search", func(w http.ResponseWriter, r *http.Request) {
			Expect(r.URL.Query().Get("q")).To(Equal("geese & killed"))
			writeJSON(w, http.StatusOK, []Result{{Title: "Getting Killed", Artist: "Geese", Year: 2025, URL: "https://example.com/album/1"}})
		})
		Expect(dl.Enabled()).To(BeTrue())
		results, err := dl.Search(ctx, "geese & killed")
		Expect(err).ToNot(HaveOccurred())
		Expect(results).To(Equal([]Result{{Title: "Getting Killed", Artist: "Geese", Year: 2025, URL: "https://example.com/album/1"}}))
	})

	It("reports what the service answered when it fails", func() {
		mux.HandleFunc("GET /jobs", func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "catalog unavailable", http.StatusBadGateway)
		})
		_, err := dl.Jobs(ctx)
		Expect(err).To(MatchError(ContainSubstring("catalog unavailable")))
	})

	It("rejects anything that is not an https link", func() {
		for _, u := range []string{"", "--config=/etc/passwd", "file:///etc/passwd", "http://example.com/album/1"} {
			_, err := dl.Start(ctx, Request{URL: u})
			Expect(err).To(MatchError(ErrInvalidURL), u)
		}
	})

	Describe("Start", func() {
		var polls atomic.Int32
		var final Job

		BeforeEach(func() {
			polls.Store(0)
			mux.HandleFunc("POST /jobs", func(w http.ResponseWriter, r *http.Request) {
				var req Request
				Expect(json.NewDecoder(r.Body).Decode(&req)).To(Succeed())
				writeJSON(w, http.StatusCreated, Job{ID: "j1", URL: req.URL, Title: req.Title, Status: StatusQueued})
			})
			mux.HandleFunc("GET /jobs/j1", func(w http.ResponseWriter, r *http.Request) {
				// Still running the first two times it is asked
				if polls.Add(1) < 3 {
					writeJSON(w, http.StatusOK, Job{ID: "j1", Status: StatusRunning, TracksTotal: 11, TracksDone: 4})
					return
				}
				writeJSON(w, http.StatusOK, final)
			})
		})

		It("scans the library once the download has finished", func() {
			final = Job{ID: "j1", Status: StatusCompleted, TracksTotal: 11, TracksDone: 11}
			job, err := dl.Start(ctx, Request{URL: "https://example.com/album/1", Title: "Getting Killed"})
			Expect(err).ToNot(HaveOccurred())
			Expect(job.ID).To(Equal("j1"))
			Expect(job.Title).To(Equal("Getting Killed"))

			Eventually(scanner.GetScanAllCallCount).Should(Equal(1))
			Expect(scanner.GetScanAllCalls()[0].FullScan).To(BeFalse())
			Expect(polls.Load()).To(BeNumerically(">=", 3))
		})

		It("does not scan when nothing was downloaded", func() {
			final = Job{ID: "j1", Status: StatusFailed, TracksTotal: 11, Error: "no source"}
			_, err := dl.Start(ctx, Request{URL: "https://example.com/album/1"})
			Expect(err).ToNot(HaveOccurred())

			Eventually(polls.Load).Should(BeNumerically(">=", 3))
			Consistently(scanner.GetScanAllCallCount, "50ms").Should(BeZero())
		})
	})
})
