package main

import (
	"context"
	"fmt"
	"io"
	"math"
	"time"

	"github.com/NamalD/navidrome/contrib/nowplaylist/lastfm"
	"github.com/NamalD/navidrome/contrib/nowplaylist/score"
	"github.com/NamalD/navidrome/contrib/nowplaylist/store"
	"github.com/NamalD/navidrome/contrib/nowplaylist/subsonic"
)

const (
	playlistIDKey     = "now_playlist_id"
	similarMaxAge     = 30 * 24 * time.Hour
	seedWindow        = 7 * 24 * time.Hour
	seedTracks        = 8
	seedArtists       = 5
	similarPerSeed    = 100
	seedHalfLife      = 2 * 24 * time.Hour
	playlistSize      = 40
	perArtist         = 4
	perAlbum          = 3
	minScoreToInclude = 0.01
)

type nowOptions struct {
	at     time.Time
	dryRun bool
	out    io.Writer
	log    io.Writer
}

// buildNow ranks the library for opts.at and, unless it is a dry run, replaces the songs of the "Now" playlist
// (creating it the first time) and renames it for the time of day.
func buildNow(ctx context.Context, lfm *lastfm.Client, nd *subsonic.Client, db *store.Store, opts nowOptions) error {
	songs, err := nd.Songs(ctx)
	if err != nil {
		return fmt.Errorf("listing the library: %w", err)
	}
	scrobbles, err := db.Plays(ctx)
	if err != nil {
		return err
	}
	if len(scrobbles) == 0 {
		return fmt.Errorf("no listening history yet: run `nowplaylist sync` first")
	}
	history := make([]score.Play, len(scrobbles))
	for i, s := range scrobbles {
		history[i] = score.Play{At: s.PlayedAt, Artist: s.Artist, Track: s.Track}
	}
	sim := similarity(ctx, lfm, db, history, opts.at, opts.log)

	lib := make([]score.Song, len(songs))
	for i, s := range songs {
		lib[i] = score.Song{ID: s.ID, Artist: s.Artist, Title: s.Title, Album: s.Album}
	}
	ranked := score.Rank(lib, history, sim, opts.at, score.DefaultWeights)
	var eligible []score.Scored
	for _, r := range ranked {
		if r.Score >= minScoreToInclude {
			eligible = append(eligible, r)
		}
	}
	picks := score.Pick(eligible, playlistSize, perArtist, perAlbum)

	name := "Now: " + slotName(opts.at)
	fmt.Fprintf(opts.out, "%s (%d of %d library songs scored above zero)\n", name, len(eligible), len(lib))
	for i, p := range picks {
		fmt.Fprintf(opts.out, "%2d. %.3f  %s - %s  [habit %.2f/%.2f recent %.2f/%.2f similar %.2f]\n", i+1, p.Score,
			p.Artist, p.Title, p.TrackHabit, p.ArtistHabit, p.TrackRecent, p.ArtistRecent, p.Similar)
	}
	if opts.dryRun {
		return nil
	}
	if len(picks) == 0 {
		return fmt.Errorf("nothing to put in the playlist")
	}

	ids := make([]string, len(picks))
	for i, p := range picks {
		ids[i] = p.ID
	}
	comment := fmt.Sprintf("Picked by nowplaylist at %s from %d Last.fm plays: what you have played lately, "+
		"what you play around this time on %s, and tracks Last.fm finds similar to your recent plays.",
		opts.at.Format("Mon 2 Jan 15:04"), len(history), dayKind(opts.at))

	id, err := nowPlaylistID(ctx, nd, db)
	if err != nil {
		return err
	}
	if id == "" {
		if id, err = nd.CreatePlaylist(ctx, name, ids); err != nil {
			return err
		}
		if err := db.SetState(ctx, playlistIDKey, id); err != nil {
			return err
		}
	} else if err := nd.ReplaceSongs(ctx, id, ids); err != nil {
		return err
	}
	if err := nd.UpdatePlaylist(ctx, id, name, comment, true); err != nil {
		return err
	}
	fmt.Fprintf(opts.out, "playlist %s updated with %d songs\n", id, len(ids))
	return nil
}

// nowPlaylistID is the playlist made on an earlier run, or "" if there is none or it has been deleted.
func nowPlaylistID(ctx context.Context, nd *subsonic.Client, db *store.Store) (string, error) {
	id, err := db.State(ctx, playlistIDKey)
	if err != nil || id == "" {
		return "", err
	}
	lists, err := nd.Playlists(ctx)
	if err != nil {
		return "", err
	}
	for _, l := range lists {
		if l.ID == id {
			return id, nil
		}
	}
	return "", nil
}

// similarity asks Last.fm what is similar to the latest plays: the most recent distinct tracks and artists of the
// last week (or the latest plays at all, after a quiet week), each weighted by how recent it is. Answers are
// cached for a month. A lookup that fails is logged and skipped.
func similarity(ctx context.Context, lfm *lastfm.Client, db *store.Store, history []score.Play, at time.Time, log io.Writer) score.Similarity {
	sim := score.Similarity{Tracks: map[string]float64{}, Artists: map[string]float64{}}
	type seed struct {
		artist, track string
		weight        float64
	}
	var tracks, artists []seed
	seenT, seenA := map[string]bool{}, map[string]bool{}
	for i := len(history) - 1; i >= 0 && (len(tracks) < seedTracks || len(artists) < seedArtists); i-- {
		p := history[i]
		age := at.Sub(p.At)
		if age < 0 {
			continue
		}
		if age > seedWindow && len(tracks) > 0 {
			break
		}
		w := math.Exp2(-float64(age) / float64(seedHalfLife))
		if tk := score.TrackKey(p.Artist, p.Track); !seenT[tk] && len(tracks) < seedTracks {
			seenT[tk] = true
			tracks = append(tracks, seed{p.Artist, p.Track, w})
		}
		if ak := score.ArtistKey(p.Artist); !seenA[ak] && len(artists) < seedArtists {
			seenA[ak] = true
			artists = append(artists, seed{p.Artist, "", w})
		}
	}
	// Weights relative to the newest seed, so a quiet week doesn't make similarity vanish.
	norm := func(ss []seed) {
		if len(ss) > 0 && ss[0].weight > 0 {
			top := ss[0].weight
			for i := range ss {
				ss[i].weight /= top
			}
		}
	}
	norm(tracks)
	norm(artists)

	lookup := func(kind, key string, fetch func() ([]lastfm.Similar, error)) []lastfm.Similar {
		if sims, ok, err := db.CachedSimilar(ctx, kind, key, similarMaxAge, at); err == nil && ok {
			return sims
		}
		sims, err := fetch()
		if err != nil {
			fmt.Fprintf(log, "similar %s %q: %v\n", kind, key, err)
			return nil
		}
		if err := db.PutSimilar(ctx, kind, key, sims, at); err != nil {
			fmt.Fprintf(log, "caching similar %s %q: %v\n", kind, key, err)
		}
		return sims
	}
	for _, s := range tracks {
		key := s.artist + "\x00" + s.track
		for _, m := range lookup("track", key, func() ([]lastfm.Similar, error) {
			return lfm.SimilarTracks(ctx, s.artist, s.track, similarPerSeed)
		}) {
			k := score.TrackKey(m.Artist, m.Track)
			sim.Tracks[k] = math.Max(sim.Tracks[k], m.Match*s.weight)
		}
	}
	for _, s := range artists {
		for _, m := range lookup("artist", s.artist, func() ([]lastfm.Similar, error) {
			return lfm.SimilarArtists(ctx, s.artist, similarPerSeed)
		}) {
			k := score.ArtistKey(m.Artist)
			sim.Artists[k] = math.Max(sim.Artists[k], m.Match*s.weight)
		}
	}
	return sim
}

func slotName(t time.Time) string {
	h := t.Hour()
	var part string
	switch {
	case h < 5:
		part = "late night"
	case h < 9:
		part = "early morning"
	case h < 12:
		part = "morning"
	case h < 17:
		part = "afternoon"
	case h < 21:
		part = "evening"
	default:
		part = "late evening"
	}
	return t.Weekday().String() + " " + part
}

func dayKind(t time.Time) string {
	if wd := t.Weekday(); wd == time.Saturday || wd == time.Sunday {
		return "weekends"
	}
	return "weekdays"
}
