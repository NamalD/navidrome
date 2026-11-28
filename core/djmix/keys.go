package djmix

// Camelot is a key's place on the Camelot wheel: Number 1-12 (a step is a fifth) and Minor (the "A" ring).
// C major is 8B, A minor 8A.
type Camelot struct {
	Number int
	Minor  bool
}

func (k Key) Camelot() Camelot {
	majorPC := k.PitchClass
	if k.Minor {
		majorPC = (k.PitchClass + 3) % 12 // the relative major
	}
	return Camelot{Number: ((majorPC*7)%12+7)%12 + 1, Minor: k.Minor}
}

// Shifted is the key after transposing by semitones.
func (k Key) Shifted(semitones int) Key {
	k.PitchClass = ((k.PitchClass+semitones)%12 + 12) % 12
	return k
}

// KeyCompatibility scores how well b follows a in a mix, from the harmonic-mixing rules: the same key or its
// relative major/minor, a step round the wheel (a fifth), and a two-step "energy boost" that works sparingly.
func KeyCompatibility(a, b Key) float64 {
	ca, cb := a.Camelot(), b.Camelot()
	d := (cb.Number - ca.Number + 12) % 12
	if d > 6 {
		d = 12 - d
	}
	sameRing := ca.Minor == cb.Minor
	switch {
	case d == 0 && sameRing:
		return 1
	case d == 0:
		return 0.9
	case d == 1 && sameRing:
		return 0.85
	case d == 2 && sameRing:
		return 0.5
	case d == 1:
		return 0.4
	}
	return 0
}
