package lastfm

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func testClient(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c := NewClient("key")
	c.BaseURL = srv.URL + "/"
	c.MinInterval = 0
	c.Backoff = time.Millisecond
	return c
}

func TestRecentTracksSkipsNowPlayingAndReadsPaging(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("method") != "user.getrecenttracks" || q.Get("user") != "u" || q.Get("api_key") != "key" ||
			q.Get("format") != "json" || q.Get("from") != "100" || q.Get("to") != "200" || q.Get("page") != "2" {
			t.Errorf("unexpected query %v", q)
		}
		w.Write([]byte(`{"recenttracks":{"track":[
			{"name":"Now","artist":{"#text":"A"},"album":{"#text":""},"@attr":{"nowplaying":"true"}},
			{"name":"Song","mbid":"t1","artist":{"#text":"Artist","mbid":"a1"},"album":{"#text":"Album","mbid":"b1"},"date":{"uts":"150","#text":"x"}}
		],"@attr":{"page":"2","totalPages":"3","total":"401","perPage":"200","user":"u"}}}`))
	})
	p, err := c.RecentTracks(context.Background(), RecentTracksQuery{
		User: "u", From: time.Unix(100, 0), To: time.Unix(200, 0), Page: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.Page != 2 || p.TotalPages != 3 || p.Total != 401 {
		t.Errorf("paging = %+v", p)
	}
	want := Scrobble{PlayedAt: time.Unix(150, 0).UTC(), Artist: "Artist", Track: "Song", Album: "Album",
		ArtistMBID: "a1", TrackMBID: "t1", AlbumMBID: "b1"}
	if len(p.Scrobbles) != 1 || p.Scrobbles[0] != want {
		t.Errorf("scrobbles = %+v", p.Scrobbles)
	}
}

func TestRecentTracksAcceptsASingleTrackObject(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"recenttracks":{"track":{"name":"Only","artist":{"#text":"A"},"album":{"#text":""},"date":{"uts":"5"}},
			"@attr":{"page":"1","totalPages":"1","total":"1"}}}`))
	})
	p, err := c.RecentTracks(context.Background(), RecentTracksQuery{User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Scrobbles) != 1 || p.Scrobbles[0].Track != "Only" {
		t.Errorf("scrobbles = %+v", p.Scrobbles)
	}
}

func TestRetriesTemporaryErrors(t *testing.T) {
	var calls atomic.Int32
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch calls.Add(1) {
		case 1:
			w.WriteHeader(http.StatusBadGateway)
		case 2:
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":29,"message":"Rate limit exceeded"}`))
		default:
			w.Write([]byte(`{"user":{"playcount":"42"}}`))
		}
	})
	n, err := c.PlayCount(context.Background(), "u")
	if err != nil {
		t.Fatal(err)
	}
	if n != 42 || calls.Load() != 3 {
		t.Errorf("playcount %d after %d calls", n, calls.Load())
	}
}

func TestDoesNotRetryPermanentErrors(t *testing.T) {
	var calls atomic.Int32
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":6,"message":"User not found"}`))
	})
	_, err := c.PlayCount(context.Background(), "nobody")
	var lfm *Error
	if !errors.As(err, &lfm) || lfm.Code != 6 {
		t.Fatalf("err = %v", err)
	}
	if calls.Load() != 1 {
		t.Errorf("%d calls, want 1", calls.Load())
	}
}
