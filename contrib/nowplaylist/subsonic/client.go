// Package subsonic is the small part of the Subsonic API (as Navidrome serves it) that nowplaylist needs: list
// the library's songs and create or replace a playlist.
package subsonic

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const apiVersion = "1.16.1"

// Client logs in with token authentication (a salted MD5 of the password), so the password itself is never sent.
type Client struct {
	BaseURL  string // e.g. https://music.namal.dev
	User     string
	Password string
	HTTP     *http.Client
}

func NewClient(baseURL, user, password string) *Client {
	return &Client{
		BaseURL:  strings.TrimRight(baseURL, "/"),
		User:     user,
		Password: password,
		HTTP:     &http.Client{Timeout: 60 * time.Second},
	}
}

// Song is a library track.
type Song struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Album    string `json:"album"`
	AlbumID  string `json:"albumId"`
	Duration int    `json:"duration"`
}

// Playlist is a playlist the user can see.
type Playlist struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Owner  string `json:"owner"`
	Public bool   `json:"public"`
}

// Error is a failed Subsonic call.
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return fmt.Sprintf("subsonic error %d: %s", e.Code, e.Message) }

type payload struct {
	Status        string `json:"status"`
	Error         *Error `json:"error"`
	SearchResult3 *struct {
		Song []Song `json:"song"`
	} `json:"searchResult3"`
	Playlists *struct {
		Playlist []Playlist `json:"playlist"`
	} `json:"playlists"`
	Playlist *Playlist `json:"playlist"`
}

type response struct {
	Response payload `json:"subsonic-response"`
}

// Songs lists every song in the library. Navidrome treats the query `""` as "match everything".
func (c *Client) Songs(ctx context.Context) ([]Song, error) {
	const pageSize = 500
	var all []Song
	for offset := 0; ; offset += pageSize {
		resp, err := c.call(ctx, "search3", url.Values{
			"query": {`""`}, "artistCount": {"0"}, "albumCount": {"0"},
			"songCount": {strconv.Itoa(pageSize)}, "songOffset": {strconv.Itoa(offset)},
		})
		if err != nil {
			return nil, err
		}
		if resp.SearchResult3 == nil {
			break
		}
		all = append(all, resp.SearchResult3.Song...)
		if len(resp.SearchResult3.Song) < pageSize {
			break
		}
	}
	return all, nil
}

// Playlists lists the playlists the user owns or can see.
func (c *Client) Playlists(ctx context.Context) ([]Playlist, error) {
	resp, err := c.call(ctx, "getPlaylists", nil)
	if err != nil {
		return nil, err
	}
	if resp.Playlists == nil {
		return nil, nil
	}
	return resp.Playlists.Playlist, nil
}

// CreatePlaylist makes a new playlist with these songs and returns its ID.
func (c *Client) CreatePlaylist(ctx context.Context, name string, songIDs []string) (string, error) {
	resp, err := c.call(ctx, "createPlaylist", url.Values{"name": {name}, "songId": songIDs})
	if err != nil {
		return "", err
	}
	if resp.Playlist == nil || resp.Playlist.ID == "" {
		return "", fmt.Errorf("createPlaylist returned no playlist")
	}
	return resp.Playlist.ID, nil
}

// ReplaceSongs sets a playlist's songs to exactly these, in this order.
func (c *Client) ReplaceSongs(ctx context.Context, playlistID string, songIDs []string) error {
	_, err := c.call(ctx, "createPlaylist", url.Values{"playlistId": {playlistID}, "songId": songIDs})
	return err
}

// UpdatePlaylist sets a playlist's name, comment and visibility to other users.
func (c *Client) UpdatePlaylist(ctx context.Context, playlistID, name, comment string, public bool) error {
	_, err := c.call(ctx, "updatePlaylist", url.Values{
		"playlistId": {playlistID}, "name": {name}, "comment": {comment}, "public": {strconv.FormatBool(public)},
	})
	return err
}

func (c *Client) call(ctx context.Context, method string, params url.Values) (*payload, error) {
	q := url.Values{}
	for k, v := range params {
		q[k] = v
	}
	salt := make([]byte, 8)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	s := hex.EncodeToString(salt)
	sum := md5.Sum([]byte(c.Password + s))
	q.Set("u", c.User)
	q.Set("t", hex.EncodeToString(sum[:]))
	q.Set("s", s)
	q.Set("v", apiVersion)
	q.Set("c", "nowplaylist")
	q.Set("f", "json")

	// POST with a form body: a playlist's song IDs would make a long URL.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/rest/"+method, strings.NewReader(q.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", method, resp.StatusCode)
	}
	var out response
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("%s: reading response: %w", method, err)
	}
	r := &out.Response
	if r.Status != "ok" {
		if r.Error != nil {
			return nil, fmt.Errorf("%s: %w", method, r.Error)
		}
		return nil, fmt.Errorf("%s: status %q", method, r.Status)
	}
	return r, nil
}
