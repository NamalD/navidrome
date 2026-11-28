// Package score ranks library songs for a moment in time from a listening history: what was played recently, what
// tends to be played at this hour on this kind of day, and what Last.fm says is similar to the recent plays.
package score

import (
	"math"
	"sort"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Play is one entry of the listening history.
type Play struct {
	At     time.Time
	Artist string
	Track  string
}

// Song is a library track that can go in a playlist.
type Song struct {
	ID     string
	Artist string
	Title  string
	Album  string
}

// Weights balances the signals. Each signal is scaled to 0..1 across the library (on a log curve) before weighting.
type Weights struct {
	TrackHabit       float64 // this track at this hour and kind of day, over the years
	ArtistHabit      float64 // this artist at this hour and kind of day
	TrackRecent      float64 // this track in the last weeks
	ArtistRecent     float64 // this artist in the last weeks
	Similar          float64 // Last.fm similarity to recent plays
	HabitHalfLife    time.Duration
	RecentHalfLife   time.Duration
	HourSpread       float64       // standard deviation, in hours, of the time-of-day match
	OtherDayKind     float64       // weight of a weekday play when scoring a weekend, and the other way round
	JustPlayedWindow time.Duration // tracks played this recently go last
}

var DefaultWeights = Weights{
	TrackHabit:       0.30,
	ArtistHabit:      0.15,
	TrackRecent:      0.20,
	ArtistRecent:     0.10,
	Similar:          0.25,
	HabitHalfLife:    2 * 365 * 24 * time.Hour,
	RecentHalfLife:   10 * 24 * time.Hour,
	HourSpread:       1.5,
	OtherDayKind:     0.5,
	JustPlayedWindow: 6 * time.Hour,
}

// Similarity is what Last.fm returned for the seeds: match scores (0..1) for track keys and artist keys.
type Similarity struct {
	Tracks  map[string]float64 // TrackKey -> best match
	Artists map[string]float64 // ArtistKey -> best match
}

// Scored is a song with its score and the parts that made it, for explaining a pick.
type Scored struct {
	Song
	Score                                                       float64
	TrackHabit, ArtistHabit, TrackRecent, ArtistRecent, Similar float64
	JustPlayed                                                  bool
}

// Rank scores every song for the moment `at` (in at's location) and returns them best first.
func Rank(songs []Song, history []Play, sim Similarity, at time.Time, w Weights) []Scored {
	type acc struct{ habit, recent float64 }
	tracks := map[string]*acc{}
	artists := map[string]*acc{}
	justPlayed := map[string]bool{}
	get := func(m map[string]*acc, k string) *acc {
		a := m[k]
		if a == nil {
			a = &acc{}
			m[k] = a
		}
		return a
	}

	atHour := hourOfDay(at)
	atWeekend := isWeekend(at)
	for _, p := range history {
		age := at.Sub(p.At)
		if age < 0 {
			continue
		}
		local := p.At.In(at.Location())
		d := hourDistance(hourOfDay(local), atHour)
		habit := math.Exp(-d*d/(2*w.HourSpread*w.HourSpread)) * halfLife(age, w.HabitHalfLife)
		if isWeekend(local) != atWeekend {
			habit *= w.OtherDayKind
		}
		recent := halfLife(age, w.RecentHalfLife)

		tk, ak := TrackKey(p.Artist, p.Track), ArtistKey(p.Artist)
		t, a := get(tracks, tk), get(artists, ak)
		t.habit += habit
		t.recent += recent
		a.habit += habit
		a.recent += recent
		if age < w.JustPlayedWindow {
			justPlayed[tk] = true
		}
	}

	out := make([]Scored, len(songs))
	var maxTH, maxAH, maxTR, maxAR float64
	for i, s := range songs {
		tk, ak := TrackKey(s.Artist, s.Title), ArtistKey(s.Artist)
		sc := Scored{Song: s, JustPlayed: justPlayed[tk]}
		if t := tracks[tk]; t != nil {
			sc.TrackHabit, sc.TrackRecent = t.habit, t.recent
		}
		if a := artists[ak]; a != nil {
			sc.ArtistHabit, sc.ArtistRecent = a.habit, a.recent
		}
		// A similar artist counts for half as much as a similar track.
		sc.Similar = math.Max(sim.Tracks[tk], 0.5*sim.Artists[ak])
		maxTH, maxAH = math.Max(maxTH, sc.TrackHabit), math.Max(maxAH, sc.ArtistHabit)
		maxTR, maxAR = math.Max(maxTR, sc.TrackRecent), math.Max(maxAR, sc.ArtistRecent)
		out[i] = sc
	}
	for i := range out {
		sc := &out[i]
		sc.TrackHabit, sc.ArtistHabit = scale(sc.TrackHabit, maxTH), scale(sc.ArtistHabit, maxAH)
		sc.TrackRecent, sc.ArtistRecent = scale(sc.TrackRecent, maxTR), scale(sc.ArtistRecent, maxAR)
		sc.Score = w.TrackHabit*sc.TrackHabit + w.ArtistHabit*sc.ArtistHabit +
			w.TrackRecent*sc.TrackRecent + w.ArtistRecent*sc.ArtistRecent + w.Similar*sc.Similar
		// Every other score is at most 1, so this puts tracks just heard behind all the rest.
		if sc.JustPlayed {
			sc.Score -= 1
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	return out
}

// Pick takes the best songs in order, with at most perArtist songs by one artist and perAlbum from one album, and
// one version of each song (a live take and the studio one share a TrackKey).
func Pick(ranked []Scored, n, perArtist, perAlbum int) []Scored {
	byArtist := map[string]int{}
	byAlbum := map[string]int{}
	seen := map[string]bool{}
	var out []Scored
	for _, s := range ranked {
		if len(out) == n {
			break
		}
		ak, alk, tk := ArtistKey(s.Artist), ArtistKey(s.Artist)+"\x00"+normalize(s.Album), TrackKey(s.Artist, s.Title)
		if seen[tk] || byArtist[ak] >= perArtist || (s.Album != "" && byAlbum[alk] >= perAlbum) {
			continue
		}
		seen[tk] = true
		byArtist[ak]++
		byAlbum[alk]++
		out = append(out, s)
	}
	return out
}

// scale maps 0..max onto 0..1 on a log curve, so one track played hundreds of times doesn't flatten the rest.
func scale(v, max float64) float64 {
	if max == 0 {
		return 0
	}
	return math.Log1p(v) / math.Log1p(max)
}

func halfLife(age, hl time.Duration) float64 {
	return math.Exp2(-float64(age) / float64(hl))
}

func hourOfDay(t time.Time) float64 {
	return float64(t.Hour()) + float64(t.Minute())/60
}

// hourDistance is the distance between two times of day, going round midnight: 23:00 and 01:00 are 2 hours apart.
func hourDistance(a, b float64) float64 {
	d := math.Abs(a - b)
	return math.Min(d, 24-d)
}

func isWeekend(t time.Time) bool {
	wd := t.Weekday()
	return wd == time.Saturday || wd == time.Sunday
}

// ArtistKey is the artist name reduced for matching: only the main artist ("A feat. B" and "A & B" are A), lower
// case, no accents or punctuation, and a leading "the" dropped, so "The National" and "national" match.
func ArtistKey(artist string) string {
	return strings.TrimPrefix(normalize(mainArtist(artist)), "the ")
}

// TrackKey matches a play to a library song by artist and title. Title decorations Last.fm and tags disagree on
// are dropped: "(Remastered 2011)", "- Live at ...", "[feat. X]".
func TrackKey(artist, title string) string {
	return ArtistKey(artist) + "\x00" + normalize(cleanTitle(title))
}

func mainArtist(a string) string {
	l := strings.ToLower(a)
	for _, sep := range []string{" feat. ", " feat ", " ft. ", " featuring ", " & ", " x ", ", ", "; "} {
		if i := strings.Index(l, sep); i > 0 {
			return a[:i]
		}
	}
	return a
}

var titleNoise = []string{"remaster", "live", "feat", "ft.", "version", "edit", "mono", "stereo", "mix", "demo", "bonus"}

func cleanTitle(t string) string {
	// Drop bracketed parts that are only decoration.
	for _, pair := range [][2]string{{"(", ")"}, {"[", "]"}} {
		for {
			i := strings.Index(t, pair[0])
			j := strings.Index(t, pair[1])
			if i < 0 || j < i || !noisy(t[i+1:j]) {
				break
			}
			t = strings.TrimSpace(t[:i] + t[j+1:])
		}
	}
	// "Song - Remastered 2011", "Song - Live at Glastonbury"
	if i := strings.LastIndex(t, " - "); i > 0 && noisy(t[i+3:]) {
		t = t[:i]
	}
	return t
}

func noisy(s string) bool {
	l := strings.ToLower(s)
	for _, n := range titleNoise {
		if strings.Contains(l, n) {
			return true
		}
	}
	return false
}

func normalize(s string) string {
	var b strings.Builder
	space := false
	for _, r := range norm.NFKD.String(strings.ToLower(s)) {
		switch {
		case unicode.Is(unicode.Mn, r): // accents left over from NFKD
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			space = false
			b.WriteRune(r)
		case r == '&':
			if b.Len() > 0 {
				b.WriteString(" and")
			}
			space = true
		default:
			space = true
		}
	}
	return b.String()
}
