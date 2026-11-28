// Turns a planner transition (GET /api/dj/next, see core/djmix) into what the mixer schedules: when and where
// the next song starts, and the gain changes on both decks, all as AudioContext times.
//
// The plan's times are seconds into each song as recorded. `outStartAt` is the context time at which the playing
// song (A) reaches plan.outStart; A plays at `rateA`, so a span of the plan in A lasts span / rateA seconds.

export const BASS_CUT_DB = -40
const CURVE_POINTS = 8
const SWAP_SECONDS = 0.02 // a bass swap is a cut on the bar line, smoothed just enough not to click
const CUT_SECONDS = 0.03

// [time, value] points for an equal-power fade from `from` to `to` (0 or 1) between t0 and t1.
const powerCurve = (t0, t1, from, to) => {
  const points = []
  for (let i = 0; i <= CURVE_POINTS; i++) {
    const x = i / CURVE_POINTS
    const up = Math.sin((x * Math.PI) / 2)
    const down = Math.cos((x * Math.PI) / 2)
    points.push([t0 + x * (t1 - t0), from < to ? up : down])
  }
  return points
}

const round = (x) => Math.round(x * 1e6) / 1e6

// Returns { type, endAt, a: lanes, b: { startAt, input, rate, semitones, ...lanes } }. Lanes are lists of
// [time, value] points, each reached by a linear ramp from the one before (the first is set outright): `fader`
// (0..1), `bass` (low-shelf gain in dB), and for an echo `send` (0..1, into the echo) and `feedback`.
export const transitionTimeline = (tr, { outStartAt, rateA = 1 }) => {
  const T = outStartAt
  const D = (tr.outEnd - tr.outStart) / rateA
  const b = {
    input: tr.inStart,
    rate: tr.rate || 1,
    semitones: tr.semitones || 0,
  }

  if (tr.type === 'blend') {
    const bars = tr.bars || 1
    const bar = D / bars
    const swapAt = T + Math.round(bars * (tr.bassSwapAt ?? 0.5)) * bar
    return {
      type: 'blend',
      outStart: tr.outStart,
      endAt: round(T + D),
      a: {
        fader: [[T, 1], ...powerCurve(T + D / 2, T + D, 1, 0)],
        bass: [
          [T, 0],
          [swapAt, 0],
          [swapAt + SWAP_SECONDS, BASS_CUT_DB],
        ],
      },
      b: {
        ...b,
        startAt: T,
        fader: powerCurve(T, T + D / 2, 0, 1),
        bass: [
          [T, BASS_CUT_DB],
          [swapAt, BASS_CUT_DB],
          [swapAt + SWAP_SECONDS, 0],
        ],
      },
    }
  }

  if (tr.type === 'echo') {
    // The last beat before the cut goes into the echo; A is cut on the downbeat and its echo dies away while
    // B comes in a bar later at full level.
    const beat = (tr.echoBeat || 0.5) / rateA
    const startAt = T + D / 2
    return {
      type: 'echo',
      endAt: round(T + D),
      echoDelay: beat,
      a: {
        fader: [
          [T, 1],
          [T + CUT_SECONDS, 0],
        ],
        bass: [[T, 0]],
        send: [
          [T - beat, 0],
          [T - beat + 0.005, 1],
          [T + CUT_SECONDS, 1],
          [T + CUT_SECONDS * 2, 0],
        ],
        feedback: [
          [T - beat, 0.55],
          [startAt, 0.55],
          [T + D, 0],
        ],
      },
      b: {
        ...b,
        startAt,
        fader: [
          [startAt, 0],
          [startAt + 0.01, 1],
        ],
        bass: [[startAt, 0]],
      },
    }
  }

  // A long crossfade, for songs without a beat to match.
  return {
    type: 'fade',
    endAt: round(T + D),
    a: { fader: powerCurve(T, T + D, 1, 0), bass: [[T, 0]] },
    b: {
      ...b,
      startAt: T,
      fader: powerCurve(T, T + D, 0, 1),
      bass: [[T, 0]],
    },
  }
}

// Applies a lane to an AudioParam: cancels what was scheduled from the first point on, then sets and ramps.
export const applyLane = (param, lane) => {
  if (!lane || lane.length === 0) return
  const [t0, v0] = lane[0]
  param.cancelScheduledValues(t0)
  param.setValueAtTime(v0, t0)
  for (let i = 1; i < lane.length; i++) {
    const [t, v] = lane[i]
    param.linearRampToValueAtTime(v, t)
  }
}

// The gain that brings a song measured at `lufs` to the mix level. Loud masters come down; quiet ones go up by
// at most a little, so blends between them stay level without clipping.
export const TARGET_LUFS = -14
export const levelFor = (lufs) => {
  if (!Number.isFinite(lufs)) return 10 ** (-4 / 20)
  const db = Math.max(-12, Math.min(3, TARGET_LUFS - lufs))
  return 10 ** (db / 20)
}
