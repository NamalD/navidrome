// Package djmix plans DJ mixes from the per-song analyses contrib/djanalysis uploads: which song to play next
// and how to move into it (a beatmatched blend, an echo-out or a long fade). The web player does the mixing.
package djmix

import (
	"encoding/json"
	"fmt"
	"math"
)

// Analysis is the part of a song's analysis document (contrib/djanalysis, schema 1) the planner reads.
// Times are seconds into the song as recorded, before any tempo change.
type Analysis struct {
	Schema    int       `json:"schema"`
	Duration  float64   `json:"duration"`
	BPM       float64   `json:"bpm"`
	Beatless  bool      `json:"beatless"`
	Beats     []float64 `json:"beats"`
	Downbeats []float64 `json:"downbeats"`
	Key       Key       `json:"key"`
	Phrases   []int     `json:"phrases"` // indices into Downbeats where a section starts
	Embedding []float64 `json:"embedding"`
	Source    struct {
		Artist string `json:"artist"`
		Title  string `json:"title"`
	} `json:"source"`
}

// Key is a musical key: a pitch class (0 = C) and mode.
type Key struct {
	PitchClass int    `json:"pitch_class"`
	Minor      bool   `json:"minor"`
	Confidence string `json:"confidence"` // high, medium or low
}

// SupportedSchema is the analysis schema version this package reads.
const SupportedSchema = 1

// ParseAnalysis reads an analysis document, normalising the embedding to unit length.
func ParseAnalysis(doc []byte) (*Analysis, error) {
	var a Analysis
	if err := json.Unmarshal(doc, &a); err != nil {
		return nil, err
	}
	if a.Schema != SupportedSchema {
		return nil, fmt.Errorf("analysis schema %d, want %d", a.Schema, SupportedSchema)
	}
	var norm float64
	for _, v := range a.Embedding {
		norm += v * v
	}
	if norm > 0 {
		norm = math.Sqrt(norm)
		for i := range a.Embedding {
			a.Embedding[i] /= norm
		}
	}
	return &a, nil
}

// beatmatchable reports whether a song has a beat grid steady enough to blend on.
func (a *Analysis) beatmatchable() bool {
	return !a.Beatless && a.BPM > 0 && len(a.Downbeats) >= 8
}
