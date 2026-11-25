// Package downloader asks an external download service to add music to the library. The service runs beside
// Navidrome (see contrib/antra-downloader), finds albums in a streaming catalog, and saves them into the music
// folder; Navidrome only relays the requests and scans the library when a download has finished.
package downloader

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
)

const (
	StatusQueued    = "queued"
	StatusRunning   = "running"
	StatusCompleted = "completed"
	StatusFailed    = "failed"
)

// A download is one request to the service, so give up watching one long after any album would have finished
const watchTimeout = 6 * time.Hour

// How many times in a row the service may fail to answer before we stop watching a job
const maxWatchErrors = 10

var (
	ErrDisabled   = errors.New("downloader not configured")
	ErrInvalidURL = errors.New("invalid url")
)

// Result is an album found in the service's catalog
type Result struct {
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Year       int    `json:"year,omitempty"`
	ArtworkURL string `json:"artworkUrl,omitempty"`
	URL        string `json:"url"`
}

// Request is what to download. Only the URL matters to the service; the rest is shown while the job runs.
type Request struct {
	URL        string `json:"url"`
	Title      string `json:"title,omitempty"`
	Artist     string `json:"artist,omitempty"`
	ArtworkURL string `json:"artworkUrl,omitempty"`
}

type Job struct {
	ID            string     `json:"id"`
	URL           string     `json:"url"`
	Title         string     `json:"title,omitempty"`
	Artist        string     `json:"artist,omitempty"`
	ArtworkURL    string     `json:"artworkUrl,omitempty"`
	Status        string     `json:"status"`
	TracksTotal   int        `json:"tracksTotal"`
	TracksDone    int        `json:"tracksDone"`
	TracksFailed  int        `json:"tracksFailed"`
	TracksSkipped int        `json:"tracksSkipped"` // already in the library
	CurrentTrack  string     `json:"currentTrack,omitempty"`
	Error         string     `json:"error,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	FinishedAt    *time.Time `json:"finishedAt,omitempty"`
}

func (j Job) Finished() bool {
	return j.Status == StatusCompleted || j.Status == StatusFailed
}

type Downloader interface {
	// Enabled reports whether a download service is configured
	Enabled() bool
	Search(ctx context.Context, query string) ([]Result, error)
	Jobs(ctx context.Context) ([]Job, error)
	// Start queues a download. The library is scanned once it has finished.
	Start(ctx context.Context, req Request) (*Job, error)
}

func New(scanner model.Scanner) Downloader {
	return &downloader{
		baseURL:      strings.TrimSuffix(conf.Server.Downloader.URL, "/"),
		scanner:      scanner,
		client:       &http.Client{Timeout: 2 * time.Minute},
		pollInterval: 5 * time.Second,
	}
}

type downloader struct {
	baseURL      string
	scanner      model.Scanner
	client       *http.Client
	pollInterval time.Duration
}

func (d *downloader) Enabled() bool {
	return d.baseURL != ""
}

func (d *downloader) Search(ctx context.Context, query string) ([]Result, error) {
	results := []Result{}
	err := d.call(ctx, http.MethodGet, "/search?q="+url.QueryEscape(query), nil, &results)
	return results, err
}

func (d *downloader) Jobs(ctx context.Context) ([]Job, error) {
	jobs := []Job{}
	err := d.call(ctx, http.MethodGet, "/jobs", nil, &jobs)
	return jobs, err
}

func (d *downloader) Start(ctx context.Context, req Request) (*Job, error) {
	u, err := url.Parse(req.URL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, ErrInvalidURL
	}
	job := &Job{}
	if err := d.call(ctx, http.MethodPost, "/jobs", req, job); err != nil {
		return nil, err
	}
	log.Info(ctx, "Download queued", "url", req.URL, "title", req.Title, "artist", req.Artist, "job", job.ID)
	// The download outlives the request that started it
	go d.watch(context.WithoutCancel(ctx), job.ID)
	return job, nil
}

// watch waits for a job to finish, then scans the library so what was downloaded shows up
func (d *downloader) watch(ctx context.Context, id string) {
	ctx, cancel := context.WithTimeout(ctx, watchTimeout)
	defer cancel()
	ticker := time.NewTicker(d.pollInterval)
	defer ticker.Stop()

	failures := 0
	for {
		select {
		case <-ctx.Done():
			log.Warn(ctx, "Gave up waiting for download to finish", "job", id)
			return
		case <-ticker.C:
		}
		job := Job{}
		if err := d.call(ctx, http.MethodGet, "/jobs/"+url.PathEscape(id), nil, &job); err != nil {
			failures++
			if failures >= maxWatchErrors {
				log.Error(ctx, "Lost track of download", "job", id, err)
				return
			}
			continue
		}
		failures = 0
		if !job.Finished() {
			continue
		}
		if job.TracksDone == 0 {
			log.Warn(ctx, "Download added nothing to the library", "job", id, "title", job.Title, "error", job.Error)
			return
		}
		log.Info(ctx, "Download finished, scanning library", "job", id, "title", job.Title, "tracks", job.TracksDone)
		if _, err := d.scanner.ScanAll(ctx, false); err != nil {
			// The scheduled scan or the watcher will pick the files up later
			log.Warn(ctx, "Could not scan library after download", "job", id, err)
		}
		return
	}
}

func (d *downloader) call(ctx context.Context, method, path string, body, result any) error {
	if !d.Enabled() {
		return ErrDisabled
	}
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reqBody = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.baseURL+path, reqBody)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return fmt.Errorf("calling download service: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("download service answered %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return json.NewDecoder(resp.Body).Decode(result)
}
