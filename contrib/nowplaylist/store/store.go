// Package store keeps the listening history in a local SQLite file.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/NamalD/navidrome/contrib/nowplaylist/lastfm"
	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS scrobbles (
	played_at   INTEGER NOT NULL, -- Unix seconds, UTC
	artist      TEXT NOT NULL,
	track       TEXT NOT NULL,
	album       TEXT NOT NULL DEFAULT '',
	artist_mbid TEXT NOT NULL DEFAULT '',
	track_mbid  TEXT NOT NULL DEFAULT '',
	album_mbid  TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (played_at, artist, track)
);
CREATE TABLE IF NOT EXISTS sync_state (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS similar_cache (
	kind       TEXT NOT NULL,    -- "track" or "artist"
	key        TEXT NOT NULL,    -- what was looked up
	fetched_at INTEGER NOT NULL, -- Unix seconds
	body       TEXT NOT NULL,    -- JSON list of lastfm.Similar
	PRIMARY KEY (kind, key)
);
`

// Store is the history database.
type Store struct{ db *sql.DB }

// Open opens or creates the database at path, creating its folder too.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("creating schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Add stores plays, skipping any already stored (same second, artist and track). It returns how many were new.
func (s *Store) Add(ctx context.Context, plays []lastfm.Scrobble) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO scrobbles
		(played_at, artist, track, album, artist_mbid, track_mbid, album_mbid) VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	added := 0
	for _, p := range plays {
		res, err := stmt.ExecContext(ctx, p.PlayedAt.Unix(), p.Artist, p.Track, p.Album, p.ArtistMBID, p.TrackMBID, p.AlbumMBID)
		if err != nil {
			return 0, err
		}
		n, _ := res.RowsAffected()
		added += int(n)
	}
	return added, tx.Commit()
}

// Count is the number of stored plays.
func (s *Store) Count(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM scrobbles`).Scan(&n)
	return n, err
}

// Recent returns the newest plays, newest first.
func (s *Store) Recent(ctx context.Context, limit int) ([]lastfm.Scrobble, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT played_at, artist, track, album, artist_mbid, track_mbid, album_mbid
		FROM scrobbles ORDER BY played_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []lastfm.Scrobble
	for rows.Next() {
		var p lastfm.Scrobble
		var at int64
		if err := rows.Scan(&at, &p.Artist, &p.Track, &p.Album, &p.ArtistMBID, &p.TrackMBID, &p.AlbumMBID); err != nil {
			return nil, err
		}
		p.PlayedAt = time.Unix(at, 0).UTC()
		out = append(out, p)
	}
	return out, rows.Err()
}

const syncedThroughKey = "synced_through"

// SyncedThrough is the end of the last sync that finished: every play before it has been fetched once. It is
// zero before the first full sync completes.
func (s *Store) SyncedThrough(ctx context.Context) (time.Time, error) {
	v, err := s.State(ctx, syncedThroughKey)
	if err != nil || v == "" {
		return time.Time{}, err
	}
	uts, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("bad %s %q: %w", syncedThroughKey, v, err)
	}
	return time.Unix(uts, 0).UTC(), nil
}

func (s *Store) SetSyncedThrough(ctx context.Context, t time.Time) error {
	return s.SetState(ctx, syncedThroughKey, strconv.FormatInt(t.Unix(), 10))
}

// Plays returns every stored play, oldest first.
func (s *Store) Plays(ctx context.Context) ([]lastfm.Scrobble, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT played_at, artist, track, album FROM scrobbles ORDER BY played_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []lastfm.Scrobble
	for rows.Next() {
		var p lastfm.Scrobble
		var at int64
		if err := rows.Scan(&at, &p.Artist, &p.Track, &p.Album); err != nil {
			return nil, err
		}
		p.PlayedAt = time.Unix(at, 0).UTC()
		out = append(out, p)
	}
	return out, rows.Err()
}

// CachedSimilar returns a Last.fm similarity answer stored less than maxAge ago. kind separates track and artist
// lookups; key is what was looked up.
func (s *Store) CachedSimilar(ctx context.Context, kind, key string, maxAge time.Duration, now time.Time) ([]lastfm.Similar, bool, error) {
	var body string
	var fetched int64
	err := s.db.QueryRowContext(ctx, `SELECT body, fetched_at FROM similar_cache WHERE kind = ? AND key = ?`, kind, key).
		Scan(&body, &fetched)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if now.Sub(time.Unix(fetched, 0)) > maxAge {
		return nil, false, nil
	}
	var out []lastfm.Similar
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		return nil, false, nil // unreadable entry: fetch again
	}
	return out, true, nil
}

func (s *Store) PutSimilar(ctx context.Context, kind, key string, sims []lastfm.Similar, now time.Time) error {
	body, err := json.Marshal(sims)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO similar_cache (kind, key, fetched_at, body) VALUES (?, ?, ?, ?)
		ON CONFLICT (kind, key) DO UPDATE SET fetched_at = excluded.fetched_at, body = excluded.body`,
		kind, key, now.Unix(), string(body))
	return err
}

// State reads a value saved with SetState; "" when there is none.
func (s *Store) State(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM sync_state WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func (s *Store) SetState(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO sync_state (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}
