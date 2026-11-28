package djmix

import (
	"errors"
	"math"
	"math/rand/v2"
	"sort"
	"strings"
)

// Transition types.
const (
	// Blend overlaps the two songs for Bars bars, beatmatched: the next song plays at Rate so its beats land on the
	// current song's, starting on a downbeat, and the low end swaps from one to the other at BassSwapAt.
	Blend = "blend"
	// Echo cuts the current song on a downbeat into an echo that dies away over a bar or two, and starts the next
	// one on its first downbeat. For songs whose tempos are too far apart to blend.
	Echo = "echo"
	// Fade crossfades over FadeSeconds. For songs without a steady beat (ambient, rubato).
	Fade = "fade"
)

const (
	// MaxRateChange is how far the next song may be sped up or slowed down to match the current one's tempo.
	MaxRateChange = 0.08
	// MaxSemitones is how far the next song may be transposed to fit the current key.
	MaxSemitones = 1
	blendBars    = 16
	minBlendBars = 4
	// maxBlendSeconds is the longest a blend should last.
	maxBlendSeconds = 32.0
	fadeSeconds     = 12.0
	echoBars        = 2
	topChoices      = 5
)

// Transition says how the player moves from the current song (A) to the next (B). Times are seconds into
// each song as recorded (the player maps them through its own rate). Rate and Semitones apply to B from
// InStart on; the player may ease B's rate back towards 1 once the transition is over.
type Transition struct {
	Type        string  `json:"type"`
	OutStart    float64 `json:"outStart"` // in A: where the transition begins (a downbeat, for blends and echoes)
	OutEnd      float64 `json:"outEnd"`   // in A: where A is gone
	InStart     float64 `json:"inStart"`  // in B: where B starts (its first downbeat, or 0 for fades)
	Bars        int     `json:"bars,omitempty"`
	BeatsPerBar int     `json:"beatsPerBar,omitempty"`
	Rate        float64 `json:"rate"`
	Semitones   int     `json:"semitones"`
	BassSwapAt  float64 `json:"bassSwapAt,omitempty"` // fraction of the transition
	EchoBeat    float64 `json:"echoBeat,omitempty"`   // seconds in A between echoes (one beat)
}

// Score explains a choice.
type Score struct {
	Total      float64 `json:"total"`
	Similarity float64 `json:"similarity"` // rank of B's sound among the candidates, 0..1
	Tempo      float64 `json:"tempo"`
	Key        float64 `json:"key"`
}

// Plan is the planner's answer: the next song and how to get there.
type Plan struct {
	SongID     string     `json:"songId"`
	Transition Transition `json:"transition"`
	Score      Score      `json:"score"`
}

// Request describes the mix so far.
type Request struct {
	Current   string   // the song playing
	Rate      float64  // its playback rate (1 = as recorded)
	Semitones int      // its transposition
	Exclude   []string // songs not to choose: everything already played or queued
	History   []string // the songs played before Current, latest last, to keep the set's sound coherent
}

var ErrNotAnalysed = errors.New("the current song has not been analysed")
var ErrNoCandidates = errors.New("no song left to mix into")

// Choose picks the next song from lib (song ID to analysis) among those allowed reports true for, and plans the
// transition: at random among the best few of Rank, weighted towards the best, so the same start gives
// different sets.
func Choose(lib map[string]*Analysis, req Request, rnd *rand.Rand, allowed func(id string) bool) (*Plan, error) {
	ranked, err := Rank(lib, req)
	if err != nil {
		return nil, err
	}
	var top []Plan
	for _, p := range ranked {
		if allowed == nil || allowed(p.SongID) {
			top = append(top, p)
			if len(top) == topChoices {
				break
			}
		}
	}
	if len(top) == 0 {
		return nil, ErrNoCandidates
	}
	var sum float64
	for _, p := range top {
		sum += weight(p.Score.Total)
	}
	pick := rnd.Float64() * sum
	for _, p := range top {
		pick -= weight(p.Score.Total)
		if pick <= 0 {
			return &p, nil
		}
	}
	return &top[len(top)-1], nil
}

// Rank scores every song that may follow the current one, on sound similarity, tempo and key, best first.
func Rank(lib map[string]*Analysis, req Request) ([]Plan, error) {
	a := lib[req.Current]
	if a == nil {
		return nil, ErrNotAnalysed
	}
	if req.Rate <= 0 {
		req.Rate = 1
	}
	excluded := map[string]bool{req.Current: true}
	for _, id := range req.Exclude {
		excluded[id] = true
	}
	// Different versions of a song played (a live take after the studio one) count as repeats.
	playedNames := map[string]bool{songName(a): true}
	for _, id := range append(append([]string{}, req.Exclude...), req.History...) {
		if p := lib[id]; p != nil {
			playedNames[songName(p)] = true
		}
	}
	centroid := sessionSound(lib, a, req.History)

	type cand struct {
		id  string
		b   *Analysis
		sim float64
	}
	var cands []cand
	for id, b := range lib {
		if excluded[id] || playedNames[songName(b)] || b.Duration < 30 {
			continue
		}
		cands = append(cands, cand{id: id, b: b, sim: cosine(centroid, b.Embedding)})
	}
	if len(cands) == 0 {
		return nil, ErrNoCandidates
	}
	sims := make([]float64, len(cands))
	for i, c := range cands {
		sims[i] = c.sim
	}
	sort.Float64s(sims)

	plans := make([]Plan, len(cands))
	for i, c := range cands {
		// Similarity as a rank (ties share one), so it is comparable with the other scores whatever the
		// embedding's spread.
		rank := 0.5
		if len(cands) > 1 {
			below := sort.SearchFloat64s(sims, c.sim)
			equal := sort.SearchFloat64s(sims, math.Nextafter(c.sim, math.Inf(1))) - below
			rank = (float64(below) + float64(equal-1)/2) / float64(len(cands)-1)
		}
		if len(c.b.Embedding) == 0 || len(centroid) == 0 {
			rank = 0
		}
		t, tempo := planTransition(a, c.b, req.Rate)
		semis, key := bestShift(a.Key.Shifted(req.Semitones), c.b.Key)
		t.Semitones = semis
		plans[i] = Plan{SongID: c.id, Transition: t, Score: Score{
			Similarity: rank, Tempo: tempo, Key: key,
			Total: 0.45*rank + 0.30*tempo + 0.25*key,
		}}
	}
	sort.Slice(plans, func(i, j int) bool {
		if plans[i].Score.Total != plans[j].Score.Total {
			return plans[i].Score.Total > plans[j].Score.Total
		}
		return plans[i].SongID < plans[j].SongID
	})
	return plans, nil
}

// weight makes the best of the top few much likelier than the fifth.
func weight(score float64) float64 { return math.Pow(math.Max(score, 0.01), 4) }

// planTransition works out how to move from a (playing at rateA) into b, and scores how well their tempos fit.
func planTransition(a, b *Analysis, rateA float64) (Transition, float64) {
	switch {
	case !a.beatmatchable() || !b.beatmatchable():
		score := 0.5
		switch {
		case !a.beatmatchable() && !b.beatmatchable():
			score = 0.8 // ambient into ambient
		case a.beatmatchable():
			score = 0.3 // leaving the beat behind
		}
		start := math.Max(0, a.Duration-fadeSeconds)
		return Transition{Type: Fade, OutStart: start, OutEnd: a.Duration, InStart: 0, Rate: 1}, score
	}

	rate := matchRate(a.BPM*rateA, b.BPM)
	off := math.Abs(rate - 1)
	if off > MaxRateChange {
		// Too far apart to blend: echo out of the last phrase and start b as recorded.
		p := outPhrase(a, echoBars)
		beat := 60 / a.BPM
		end := math.Min(a.Downbeats[p]+float64(echoBars*4)*beat, a.Duration)
		return Transition{
			Type: Echo, OutStart: a.Downbeats[p], OutEnd: end, InStart: b.Downbeats[0],
			Bars: echoBars, BeatsPerBar: 4, Rate: 1, EchoBeat: beat,
		}, 0.1
	}

	// 16 bars, halved while that would run past maxBlendSeconds (16 bars at 80 BPM is 48 s) or start before
	// the middle of a (short songs), down to minBlendBars; and never more bars than either song has.
	bars := blendBars
	barSeconds := 4 * 60 / (a.BPM * rateA)
	for bars > minBlendBars && (float64(bars)*barSeconds > maxBlendSeconds ||
		a.Downbeats[outPhrase(a, bars)] < 0.5*a.Duration) {
		bars /= 2
	}
	bars = min(bars, len(b.Downbeats)-1, len(a.Downbeats)-1)
	if bars < minBlendBars {
		return Transition{Type: Fade, OutStart: math.Max(0, a.Duration-fadeSeconds), OutEnd: a.Duration, Rate: 1}, 0.3
	}
	p := outPhrase(a, bars)
	return Transition{
		Type: Blend, OutStart: a.Downbeats[p], OutEnd: a.Downbeats[p+bars], InStart: b.Downbeats[0],
		Bars: bars, BeatsPerBar: 4, Rate: rate, BassSwapAt: 0.5,
	}, 1 - off/MaxRateChange
}

// matchRate is the rate at which b's beats line up with a tempo of target BPM, folding b's tempo by an octave
// either way (the analysis can hear a song at half or double its felt tempo).
func matchRate(target, bpm float64) float64 {
	best := math.Inf(1)
	for _, f := range []float64{0.5, 1, 2} {
		r := target / (bpm * f)
		if math.Abs(r-1) < math.Abs(best-1) {
			best = r
		}
	}
	return best
}

// outPhrase is the downbeat index at which to start leaving a: the latest phrase start that leaves `bars`
// bars before a's last downbeat, as long as it is in the last 40% of the song; otherwise just `bars` bars from
// the end.
func outPhrase(a *Analysis, bars int) int {
	last := len(a.Downbeats) - 1 - bars
	if last < 0 {
		return 0
	}
	for i := len(a.Phrases) - 1; i >= 0; i-- {
		p := a.Phrases[i]
		if p <= last && a.Downbeats[p] >= 0.6*a.Duration {
			return p
		}
	}
	return last
}

// bestShift is the transposition of b (within MaxSemitones) that fits after a best, and its score. A key the
// detectors disagreed on counts for less, and every semitone costs a little.
func bestShift(a, b Key) (int, float64) {
	best, bestScore := 0, -1.0
	for s := -MaxSemitones; s <= MaxSemitones; s++ {
		score := KeyCompatibility(a, b.Shifted(s)) - 0.1*math.Abs(float64(s))
		if score > bestScore {
			best, bestScore = s, score
		}
	}
	trust := 1.0
	if a.Confidence == "low" || b.Confidence == "low" {
		trust = 0.5
	}
	return best, 0.5 + (math.Max(bestScore, 0)-0.5)*trust
}

// sessionSound is the sound to stay close to: the current song, with the recent history pulling a little.
func sessionSound(lib map[string]*Analysis, a *Analysis, history []string) []float64 {
	if len(a.Embedding) == 0 {
		return nil
	}
	out := make([]float64, len(a.Embedding))
	copy(out, a.Embedding)
	const recent = 3
	start := max(0, len(history)-recent)
	for _, id := range history[start:] {
		if h := lib[id]; h != nil && len(h.Embedding) == len(out) {
			for i, v := range h.Embedding {
				out[i] += 0.3 * v
			}
		}
	}
	return out
}

func cosine(a, b []float64) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / math.Sqrt(na*nb)
}

func songName(a *Analysis) string {
	title := strings.ToLower(a.Source.Title)
	if i := strings.IndexAny(title, "(["); i > 0 {
		title = title[:i]
	}
	if i := strings.Index(title, " - "); i > 0 {
		title = title[:i]
	}
	return strings.ToLower(strings.TrimSpace(a.Source.Artist)) + "\x00" + strings.TrimSpace(title)
}
