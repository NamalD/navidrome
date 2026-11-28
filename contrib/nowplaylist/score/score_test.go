package score

import (
	"testing"
	"time"
)

func TestTrackKeyMatchesCommonVariants(t *testing.T) {
	same := [][2][2]string{
		{{"Fontaines D.C.", "Boys in the Better Land"}, {"Fontaines D.C", "Boys In The Better Land"}},
		{{"The National", "Bloodbuzz Ohio"}, {"National", "Bloodbuzz Ohio - Remastered 2019"}},
		{{"James Blake", "Retrograde"}, {"James Blake feat. Someone", "Retrograde (Live at Glastonbury)"}},
		{{"Björk", "Jóga"}, {"Bjork", "Joga"}},
		{{"Florence + the Machine", "Dog Days Are Over"}, {"Florence + The Machine", "Dog Days Are Over [Bonus Track]"}},
	}
	for _, c := range same {
		a, b := TrackKey(c[0][0], c[0][1]), TrackKey(c[1][0], c[1][1])
		if a != b {
			t.Errorf("%v and %v: %q != %q", c[0], c[1], a, b)
		}
	}
	// Brackets that are part of the title stay.
	if TrackKey("A", "Song (Part 2)") == TrackKey("A", "Song") {
		t.Error(`"(Part 2)" was dropped`)
	}
}

func TestHourDistanceWrapsMidnight(t *testing.T) {
	if d := hourDistance(23, 1); d != 2 {
		t.Errorf("23→1 = %v", d)
	}
}

func TestRankPrefersTheHabitOfThisHour(t *testing.T) {
	loc := time.UTC
	at := time.Date(2026, 11, 25, 8, 0, 0, 0, loc) // a Wednesday morning
	songs := []Song{
		{ID: "morning", Artist: "A", Title: "Morning"},
		{ID: "night", Artist: "B", Title: "Night"},
	}
	var history []Play
	// Months of plays: "Morning" around 8:00 and "Night" around 23:00, on weekdays, the same number of times.
	for d := 30; d < 200; d++ {
		day := at.AddDate(0, 0, -d)
		if isWeekend(day) {
			continue
		}
		history = append(history,
			Play{At: day.Add(10 * time.Minute), Artist: "A", Track: "Morning"},
			Play{At: day.Add(15 * time.Hour), Artist: "B", Track: "Night"},
		)
	}
	ranked := Rank(songs, history, Similarity{}, at, DefaultWeights)
	if ranked[0].ID != "morning" {
		t.Fatalf("at 08:00 ranked %v", ranked)
	}
	ranked = Rank(songs, history, Similarity{}, at.Add(15*time.Hour), DefaultWeights)
	if ranked[0].ID != "night" {
		t.Fatalf("at 23:00 ranked %v", ranked)
	}
}

func TestRankLiftsRecentAndSimilarAndHoldsBackJustPlayed(t *testing.T) {
	at := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	songs := []Song{
		{ID: "old", Artist: "Old", Title: "Old"},
		{ID: "recent", Artist: "New", Title: "Recent"},
		{ID: "similar", Artist: "Sim", Title: "Similar"},
		{ID: "now", Artist: "Now", Title: "Now"},
	}
	history := []Play{
		{At: at.AddDate(-3, 0, 0), Artist: "Old", Track: "Old"},
		{At: at.AddDate(0, 0, -2), Artist: "New", Track: "Recent"},
		{At: at.Add(-time.Hour), Artist: "Now", Track: "Now"},
	}
	sim := Similarity{Tracks: map[string]float64{TrackKey("Sim", "Similar"): 1}}
	ranked := Rank(songs, history, sim, at, DefaultWeights)
	pos := map[string]int{}
	for i, s := range ranked {
		pos[s.ID] = i
	}
	if pos["recent"] > pos["old"] {
		t.Errorf("recent play ranked below a three-year-old one: %v", ranked)
	}
	if pos["similar"] > pos["old"] {
		t.Errorf("similar song ranked below an old play: %v", ranked)
	}
	if pos["now"] != len(songs)-1 {
		t.Errorf("song played an hour ago not last: %v", ranked)
	}
}

func TestPickLimitsArtistsAndAlbums(t *testing.T) {
	var ranked []Scored
	for _, s := range []Song{
		{ID: "1", Artist: "A", Title: "1", Album: "X"}, {ID: "2", Artist: "A", Title: "2", Album: "X"},
		{ID: "3", Artist: "A", Title: "3", Album: "X"}, {ID: "4", Artist: "A", Title: "4", Album: "Y"},
		{ID: "5", Artist: "A", Title: "5", Album: "Y"},
		{ID: "6", Artist: "B", Title: "Song", Album: "Z"}, {ID: "7", Artist: "B", Title: "Song (Live)", Album: "W"},
	} {
		ranked = append(ranked, Scored{Song: s})
	}
	got := Pick(ranked, 10, 3, 2)
	var ids string
	for _, s := range got {
		ids += s.ID
	}
	if ids != "1246" {
		t.Errorf("picked %s, want 1246", ids)
	}
}
