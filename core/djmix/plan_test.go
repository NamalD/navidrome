package djmix

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"time"

	"github.com/navidrome/navidrome/tests"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

// song makes an analysis of a steady track: bpm, bars of 4 beats, a key, and a sound (the embedding points
// along one axis, so songs with the same `sound` are similar).
func song(title string, bpm float64, bars int, key Key, sound int) *Analysis {
	beat := 60 / bpm
	a := &Analysis{Schema: 1, BPM: bpm, Key: key, Duration: float64(bars*4)*beat + 2}
	a.Source.Artist, a.Source.Title = "Artist "+title, title
	for i := 0; i < bars*4; i++ {
		a.Beats = append(a.Beats, 0.5+float64(i)*beat)
		if i%4 == 0 {
			a.Downbeats = append(a.Downbeats, 0.5+float64(i)*beat)
		}
	}
	for p := 0; p < bars; p += 16 {
		a.Phrases = append(a.Phrases, p)
	}
	a.Embedding = make([]float64, 8)
	a.Embedding[sound%8] = 1
	a.Embedding[(sound+1)%8] = 0.2
	return a
}

var (
	cMajor = Key{PitchClass: 0, Confidence: "high"}
	aMinor = Key{PitchClass: 9, Minor: true, Confidence: "high"}
	gMajor = Key{PitchClass: 7, Confidence: "high"}
	fSharp = Key{PitchClass: 6, Confidence: "high"}
)

// best is the top-ranked plan.
func best(lib map[string]*Analysis, req Request) *Plan {
	ranked, err := Rank(lib, req)
	ExpectWithOffset(1, err).ToNot(HaveOccurred())
	return &ranked[0]
}

var _ = Describe("Camelot keys", func() {
	It("places keys on the wheel", func() {
		Expect(cMajor.Camelot()).To(Equal(Camelot{Number: 8}))
		Expect(aMinor.Camelot()).To(Equal(Camelot{Number: 8, Minor: true}))
		Expect(gMajor.Camelot()).To(Equal(Camelot{Number: 9}))
		Expect(Key{PitchClass: 11}.Camelot()).To(Equal(Camelot{Number: 1}))
		Expect(Key{PitchClass: 8, Minor: true}.Camelot()).To(Equal(Camelot{Number: 1, Minor: true}))
	})

	It("scores harmonic moves", func() {
		Expect(KeyCompatibility(cMajor, cMajor)).To(Equal(1.0))
		Expect(KeyCompatibility(cMajor, aMinor)).To(Equal(0.9))
		Expect(KeyCompatibility(cMajor, gMajor)).To(Equal(0.85))
		Expect(KeyCompatibility(cMajor, Key{PitchClass: 2})).To(Equal(0.5)) // D: two steps
		Expect(KeyCompatibility(cMajor, fSharp)).To(Equal(0.0))             // tritone, opposite side
		Expect(KeyCompatibility(Key{PitchClass: 11}, cMajor)).To(Equal(0.0))
	})

	It("finds the semitone shift that fits", func() {
		// C# major, a semitone up from C: shifting it down a semitone makes it C.
		s, score := bestShift(cMajor, Key{PitchClass: 1, Confidence: "high"})
		Expect(s).To(Equal(-1))
		Expect(score).To(BeNumerically("~", 0.9, 1e-9))
		s, _ = bestShift(cMajor, gMajor)
		Expect(s).To(Equal(0))
	})
})

var _ = Describe("Choose", func() {
	It("blends into a similar song in a compatible key at a close tempo, on a phrase near the end", func() {
		lib := map[string]*Analysis{
			"a":    song("A", 124, 96, cMajor, 0),
			"good": song("Good", 126, 80, gMajor, 0),
			"far":  song("Far", 90, 80, gMajor, 0),
			// A major (11B): no shift of a semitone brings it near C (8B).
			"clash":   song("Clash", 124, 80, Key{PitchClass: 9, Confidence: "high"}, 0),
			"strange": song("Strange", 124, 80, cMajor, 4),
		}
		p := best(lib, Request{Current: "a", Rate: 1})
		Expect(p.SongID).To(Equal("good"))
		t := p.Transition
		Expect(t.Type).To(Equal(Blend))
		Expect(t.Rate).To(BeNumerically("~", 124.0/126, 1e-9))
		Expect(t.Bars).To(Equal(16))
		a := lib["a"]
		Expect(t.OutStart).To(Equal(a.Downbeats[64])) // the last phrase start with 16 bars after it
		Expect(t.OutEnd).To(Equal(a.Downbeats[80]))
		Expect(t.InStart).To(Equal(lib["good"].Downbeats[0]))
		Expect(t.Semitones).To(Equal(0))
	})

	It("shortens blends that would run long at slow tempos or start early in short songs", func() {
		lib := map[string]*Analysis{
			"slow": song("Slow", 80, 96, cMajor, 0), // 16 bars at 80 BPM would be 48 s
			"next": song("Next", 80, 96, cMajor, 0),
		}
		p := best(lib, Request{Current: "slow"})
		Expect(p.Transition.Bars).To(Equal(8))
		Expect(p.Transition.OutEnd - p.Transition.OutStart).To(BeNumerically("<=", maxBlendSeconds))

		lib = map[string]*Analysis{
			"short": song("Short", 124, 20, cMajor, 0), // 20 bars: a 16-bar blend would start at bar 3
			"next":  song("Next", 124, 64, cMajor, 0),
		}
		p = best(lib, Request{Current: "short"})
		Expect(p.Transition.Bars).To(Equal(8))
		Expect(p.Transition.OutStart).To(BeNumerically(">=", lib["short"].Duration/2))
	})

	It("matches tempo across an octave and follows the current rate", func() {
		lib := map[string]*Analysis{
			"a":    song("A", 140, 64, cMajor, 0),
			"half": song("Half", 71, 64, cMajor, 0),
		}
		p := best(lib, Request{Current: "a", Rate: 1.02})
		Expect(p.Transition.Type).To(Equal(Blend))
		Expect(p.Transition.Rate).To(BeNumerically("~", 140*1.02/142, 1e-9))
	})

	It("echoes out when the tempos are too far apart, and fades for beatless songs", func() {
		lib := map[string]*Analysis{
			"a":   song("A", 124, 64, cMajor, 0),
			"far": song("Far", 95, 64, cMajor, 0),
		}
		p := best(lib, Request{Current: "a", Rate: 1})
		Expect(p.Transition.Type).To(Equal(Echo))
		Expect(p.Transition.Rate).To(Equal(1.0))
		Expect(p.Transition.EchoBeat).To(BeNumerically("~", 60.0/124, 1e-9))
		Expect(p.Transition.OutEnd).To(BeNumerically(">", p.Transition.OutStart))

		amb := song("Ambient", 60, 40, cMajor, 0)
		amb.Beatless = true
		lib["amb"] = amb
		delete(lib, "far")
		p = best(lib, Request{Current: "a", Rate: 1})
		Expect(p.Transition.Type).To(Equal(Fade))
		Expect(p.Transition.OutEnd).To(Equal(lib["a"].Duration))
		Expect(p.Transition.OutEnd - p.Transition.OutStart).To(Equal(fadeSeconds))
	})

	It("never repeats a song or another version of it, and respects allowed", func() {
		live := song("Good (Live)", 124, 64, cMajor, 0)
		live.Source.Artist = "Artist Good"
		lib := map[string]*Analysis{
			"a":     song("A", 124, 64, cMajor, 0),
			"good":  song("Good", 124, 64, cMajor, 0),
			"live":  live,
			"other": song("Other", 124, 64, cMajor, 3),
		}
		for range 20 {
			p, err := Choose(lib, Request{Current: "a", Exclude: []string{"good"}}, rand.New(rand.NewPCG(rand.Uint64(), 0)), nil)
			Expect(err).ToNot(HaveOccurred())
			Expect(p.SongID).To(Equal("other"))
		}
		_, err := Choose(lib, Request{Current: "a", Exclude: []string{"good"}}, rand.New(rand.NewPCG(1, 1)),
			func(id string) bool { return id != "other" })
		Expect(err).To(MatchError(ErrNoCandidates))
	})

	It("transposes by a semitone when that makes the keys fit", func() {
		lib := map[string]*Analysis{
			"a":      song("A", 124, 64, cMajor, 0),
			"csharp": song("C sharp", 124, 64, Key{PitchClass: 1, Confidence: "high"}, 0),
		}
		p := best(lib, Request{Current: "a"})
		Expect(p.Transition.Semitones).To(Equal(-1))
		// The current song's own shift counts: C shifted up is C#, which fits C# as is.
		p = best(lib, Request{Current: "a", Semitones: 1})
		Expect(p.Transition.Semitones).To(Equal(0))
	})

	It("plans into a song the user queued, even a poor fit", func() {
		lib := map[string]*Analysis{
			"a":   song("A", 124, 64, cMajor, 0),
			"far": song("Far", 95, 64, fSharp, 5),
		}
		p, err := PlanTo(lib, Request{Current: "a"}, "far")
		Expect(err).ToNot(HaveOccurred())
		Expect(p.SongID).To(Equal("far"))
		Expect(p.Transition.Type).To(Equal(Echo))
		_, err = PlanTo(lib, Request{Current: "a"}, "nope")
		Expect(err).To(MatchError(ErrNextNotAnalysed))
	})

	It("needs the current song to be analysed", func() {
		_, err := Choose(map[string]*Analysis{}, Request{Current: "x"}, rand.New(rand.NewPCG(1, 1)), nil)
		Expect(err).To(MatchError(ErrNotAnalysed))
	})

	It("varies the choice among the best few", func() {
		lib := map[string]*Analysis{"a": song("A", 124, 64, cMajor, 0)}
		for i := range 6 {
			lib[fmt.Sprint(i)] = song(fmt.Sprint("S", i), 124+float64(i)*0.2, 64, cMajor, 0)
		}
		seen := map[string]bool{}
		for i := range 50 {
			p, err := Choose(lib, Request{Current: "a"}, rand.New(rand.NewPCG(uint64(i), 9)), nil)
			Expect(err).ToNot(HaveOccurred())
			seen[p.SongID] = true
		}
		Expect(len(seen)).To(BeNumerically(">=", 3))
	})
})

var _ = Describe("Library", func() {
	It("parses stored analyses, skips bad ones and reloads after the TTL", func() {
		ds := &tests.MockDataStore{}
		repo := ds.DJAnalysis(context.Background())
		doc, _ := json.Marshal(song("A", 120, 32, cMajor, 0))
		Expect(repo.Put("a", doc)).To(Succeed())
		Expect(repo.Put("bad", []byte(`{"schema":99}`))).To(Succeed())

		now := time.Unix(1_800_000_000, 0)
		lib := NewLibrary(ds)
		lib.now = func() time.Time { return now }
		songs, err := lib.Songs(context.Background())
		Expect(err).ToNot(HaveOccurred())
		Expect(songs).To(HaveKey("a"))
		Expect(songs).ToNot(HaveKey("bad"))
		Expect(math.Abs(cosine(songs["a"].Embedding, songs["a"].Embedding) - 1)).To(BeNumerically("<", 1e-9))

		Expect(repo.Put("b", doc)).To(Succeed())
		songs, _ = lib.Songs(context.Background())
		Expect(songs).ToNot(HaveKey("b"))
		now = now.Add(libraryTTL + time.Second)
		songs, _ = lib.Songs(context.Background())
		Expect(songs).To(HaveKey("b"))
	})
})
