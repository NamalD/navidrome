// Package lastfm reads a user's listening history from the Last.fm API (https://www.last.fm/api).
package lastfm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const DefaultBaseURL = "https://ws.audioscrobbler.com/2.0/"

// MaxPageSize is the largest `limit` user.getRecentTracks accepts.
const MaxPageSize = 200

// Client calls the Last.fm API with an API key. It spaces requests out and retries the errors Last.fm marks as
// temporary.
type Client struct {
	APIKey  string
	BaseURL string
	HTTP    *http.Client
	// MinInterval is the least time between two requests. Last.fm asks clients to stay well under 5 a second.
	MinInterval time.Duration
	// Retries is how many times a temporary failure is retried before giving up.
	Retries int
	// Backoff is the wait before the first retry; it doubles each time.
	Backoff time.Duration

	last time.Time
}

func NewClient(apiKey string) *Client {
	return &Client{
		APIKey:      apiKey,
		BaseURL:     DefaultBaseURL,
		HTTP:        &http.Client{Timeout: 30 * time.Second},
		MinInterval: 250 * time.Millisecond,
		Retries:     5,
		Backoff:     2 * time.Second,
	}
}

// Scrobble is one finished play.
type Scrobble struct {
	PlayedAt   time.Time
	Artist     string
	Track      string
	Album      string
	ArtistMBID string
	TrackMBID  string
	AlbumMBID  string
}

// Page is one page of user.getRecentTracks.
type Page struct {
	Scrobbles  []Scrobble
	Page       int
	TotalPages int
	Total      int
}

// RecentTracksQuery selects plays by time. Zero times are left out of the request.
type RecentTracksQuery struct {
	User  string
	From  time.Time
	To    time.Time
	Page  int
	Limit int
}

// RecentTracks fetches one page of a user's plays, newest first. The track playing now, which has no timestamp,
// is left out.
func (c *Client) RecentTracks(ctx context.Context, q RecentTracksQuery) (Page, error) {
	params := url.Values{"method": {"user.getrecenttracks"}, "user": {q.User}}
	if !q.From.IsZero() {
		params.Set("from", strconv.FormatInt(q.From.Unix(), 10))
	}
	if !q.To.IsZero() {
		params.Set("to", strconv.FormatInt(q.To.Unix(), 10))
	}
	if q.Page > 0 {
		params.Set("page", strconv.Itoa(q.Page))
	}
	if q.Limit > 0 {
		params.Set("limit", strconv.Itoa(q.Limit))
	}
	var resp recentTracksResponse
	if err := c.call(ctx, params, &resp); err != nil {
		return Page{}, err
	}
	return resp.toPage()
}

// PlayCount is the user's total number of scrobbles, as their profile shows it.
func (c *Client) PlayCount(ctx context.Context, user string) (int, error) {
	var resp struct {
		User struct {
			PlayCount string `json:"playcount"`
		} `json:"user"`
	}
	if err := c.call(ctx, url.Values{"method": {"user.getinfo"}, "user": {user}}, &resp); err != nil {
		return 0, err
	}
	return strconv.Atoi(resp.User.PlayCount)
}

// Error is an error Last.fm returned (https://www.last.fm/api/errorcodes).
type Error struct {
	Code    int    `json:"error"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return fmt.Sprintf("last.fm error %d: %s", e.Code, e.Message) }

// Temporary reports whether retrying may succeed: operation failed (8), service offline (11), temporary error
// (16) and rate limit exceeded (29).
func (e *Error) Temporary() bool {
	switch e.Code {
	case 8, 11, 16, 29:
		return true
	}
	return false
}

type httpStatusError struct{ status int }

func (e *httpStatusError) Error() string { return fmt.Sprintf("last.fm answered HTTP %d", e.status) }

func (c *Client) call(ctx context.Context, params url.Values, out any) error {
	params.Set("api_key", c.APIKey)
	params.Set("format", "json")
	wait := c.Backoff
	for attempt := 0; ; attempt++ {
		err := c.once(ctx, params, out)
		if err == nil || attempt >= c.Retries || !retryable(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		wait *= 2
	}
}

func retryable(err error) bool {
	var lfm *Error
	if errors.As(err, &lfm) {
		return lfm.Temporary()
	}
	var status *httpStatusError
	if errors.As(err, &status) {
		return status.status >= 500 || status.status == http.StatusTooManyRequests
	}
	// Network failures and cut-off bodies.
	return !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded)
}

func (c *Client) once(ctx context.Context, params url.Values, out any) error {
	if d := c.MinInterval - time.Since(c.last); d > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
		}
	}
	c.last = time.Now()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"?"+params.Encode(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "nowplaylist/0.1")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// Last.fm reports API errors as JSON, often with a 4xx status, so read the body before judging the status.
	var raw json.RawMessage
	decErr := json.NewDecoder(resp.Body).Decode(&raw)
	if decErr == nil {
		var apiErr Error
		if json.Unmarshal(raw, &apiErr) == nil && apiErr.Code != 0 {
			return &apiErr
		}
	}
	if resp.StatusCode != http.StatusOK {
		return &httpStatusError{resp.StatusCode}
	}
	if decErr != nil {
		return fmt.Errorf("reading last.fm response: %w", decErr)
	}
	return json.Unmarshal(raw, out)
}

type textField struct {
	Text string `json:"#text"`
	MBID string `json:"mbid"`
}

type recentTrack struct {
	Name   string    `json:"name"`
	MBID   string    `json:"mbid"`
	Artist textField `json:"artist"`
	Album  textField `json:"album"`
	Date   *struct {
		UTS string `json:"uts"`
	} `json:"date"`
	Attr *struct {
		NowPlaying string `json:"nowplaying"`
	} `json:"@attr"`
}

// trackList accepts both shapes Last.fm uses for `track`: an array, or a bare object when there is one play.
type trackList []recentTrack

func (l *trackList) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '{' {
		var one recentTrack
		if err := json.Unmarshal(b, &one); err != nil {
			return err
		}
		*l = trackList{one}
		return nil
	}
	return json.Unmarshal(b, (*[]recentTrack)(l))
}

type recentTracksResponse struct {
	RecentTracks struct {
		Track trackList `json:"track"`
		Attr  struct {
			Page       string `json:"page"`
			TotalPages string `json:"totalPages"`
			Total      string `json:"total"`
		} `json:"@attr"`
	} `json:"recenttracks"`
}

func (r recentTracksResponse) toPage() (Page, error) {
	var p Page
	var err error
	attr := r.RecentTracks.Attr
	if p.Page, err = atoiOrZero(attr.Page); err != nil {
		return Page{}, fmt.Errorf("page: %w", err)
	}
	if p.TotalPages, err = atoiOrZero(attr.TotalPages); err != nil {
		return Page{}, fmt.Errorf("totalPages: %w", err)
	}
	if p.Total, err = atoiOrZero(attr.Total); err != nil {
		return Page{}, fmt.Errorf("total: %w", err)
	}
	for _, t := range r.RecentTracks.Track {
		if t.Date == nil || (t.Attr != nil && t.Attr.NowPlaying == "true") {
			continue
		}
		uts, err := strconv.ParseInt(t.Date.UTS, 10, 64)
		if err != nil {
			return Page{}, fmt.Errorf("timestamp of %q: %w", t.Name, err)
		}
		p.Scrobbles = append(p.Scrobbles, Scrobble{
			PlayedAt:   time.Unix(uts, 0).UTC(),
			Artist:     t.Artist.Text,
			Track:      t.Name,
			Album:      t.Album.Text,
			ArtistMBID: t.Artist.MBID,
			TrackMBID:  t.MBID,
			AlbumMBID:  t.Album.MBID,
		})
	}
	return p, nil
}

func atoiOrZero(s string) (int, error) {
	if s == "" {
		return 0, nil
	}
	return strconv.Atoi(s)
}

// Similar is a track or artist Last.fm considers similar, with its match score from 0 to 1. Track is empty for
// similar artists.
type Similar struct {
	Artist string
	Track  string
	Match  float64
}

// flexFloat reads a number Last.fm sends either as a JSON number or as a string.
type flexFloat float64

func (f *flexFloat) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	*f = flexFloat(v)
	return err
}

// SimilarTracks is track.getSimilar.
func (c *Client) SimilarTracks(ctx context.Context, artist, track string, limit int) ([]Similar, error) {
	var resp struct {
		SimilarTracks struct {
			Track []struct {
				Name   string    `json:"name"`
				Match  flexFloat `json:"match"`
				Artist struct {
					Name string `json:"name"`
				} `json:"artist"`
			} `json:"track"`
		} `json:"similartracks"`
	}
	err := c.call(ctx, url.Values{"method": {"track.getsimilar"}, "artist": {artist}, "track": {track},
		"limit": {strconv.Itoa(limit)}, "autocorrect": {"1"}}, &resp)
	if err != nil {
		return nil, err
	}
	out := make([]Similar, 0, len(resp.SimilarTracks.Track))
	for _, t := range resp.SimilarTracks.Track {
		out = append(out, Similar{Artist: t.Artist.Name, Track: t.Name, Match: float64(t.Match)})
	}
	return out, nil
}

// SimilarArtists is artist.getSimilar.
func (c *Client) SimilarArtists(ctx context.Context, artist string, limit int) ([]Similar, error) {
	var resp struct {
		SimilarArtists struct {
			Artist []struct {
				Name  string    `json:"name"`
				Match flexFloat `json:"match"`
			} `json:"artist"`
		} `json:"similarartists"`
	}
	err := c.call(ctx, url.Values{"method": {"artist.getsimilar"}, "artist": {artist},
		"limit": {strconv.Itoa(limit)}, "autocorrect": {"1"}}, &resp)
	if err != nil {
		return nil, err
	}
	out := make([]Similar, 0, len(resp.SimilarArtists.Artist))
	for _, a := range resp.SimilarArtists.Artist {
		out = append(out, Similar{Artist: a.Name, Match: float64(a.Match)})
	}
	return out, nil
}
