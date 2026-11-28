import { describe, expect, it } from 'vitest'
import {
  barPhase,
  barStart,
  beatWarp,
  fitGrid,
  gridBeat,
  nearestIndex,
} from './warp'

// Beats at `bpm` from `start`, `count` of them; `wander(i)` adds an offset to beat i.
const grid = (bpm, count, start = 0, wander = () => 0) =>
  Array.from({ length: count }, (_, i) => start + (i * 60) / bpm + wander(i))

// What beat_this writes: times rounded to its 20 ms frames.
const frames = (beats) => beats.map((b) => Math.round(b * 50) / 50)

const T = 100 // context time of A's outStart
const setup = (aBeats, bBeats, { rateA = 1, rateB = 1, bars = 8 } = {}) => {
  const outStart = aBeats[64]
  const aTimeOf = (x) => T + (x - outStart) / rateA
  const endAt = aTimeOf(aBeats[64 + bars * 4])
  return {
    aBeats,
    bBeats,
    outStart,
    inStart: bBeats[0],
    endAt,
    aTimeOf,
    rateA,
    rateB,
  }
}

// Where B's song time `x` plays, by the warp's first segment.
const playAt = (warp, x) => warp[0].t + (x - warp[0].input) / warp[0].rate

describe('fitGrid', () => {
  it('finds the period and phase through frame-rounded beats to well under a frame', () => {
    const g = fitGrid(frames(grid(139.97, 200, 0.013)), 10, 60)
    expect(g.period).toBeCloseTo(60 / 139.97, 4)
    expect(
      Math.abs(
        gridBeat(g, 30) -
          (0.013 + Math.round((30 - 0.013) / g.period) * g.period),
      ),
    ).toBeLessThan(0.003)
  })

  it('ignores missing beats, extra beats and a stretch on the off-beat', () => {
    const beats = frames(grid(140, 200)).filter((_, i) => i % 9 !== 4)
    beats.push(20.11, 25.5)
    for (let i = 0; i < beats.length; i++)
      if (beats[i] > 40 && beats[i] < 50) beats[i] += 60 / 280
    beats.sort((a, b) => a - b)
    const g = fitGrid(beats, 0, 80)
    expect(g.period).toBeCloseTo(60 / 140, 4)
    expect(Math.abs(gridBeat(g, 30.1) - 30)).toBeLessThan(0.003)
  })

  it('goes by the phase most beats agree on', () => {
    const beats = grid(140, 140, 0.1).map((x) => (x < 11 ? x + 30 / 140 : x))
    const g = fitGrid(beats, 0, 60)
    expect(
      Math.abs(
        gridBeat(g, 5) - (0.1 + Math.round((5 - 0.1) / g.period) * g.period),
      ),
    ).toBeLessThan(0.001)
  })

  it('finds nothing in scattered beats', () => {
    let seed = 1
    const rnd = () =>
      ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
    const beats = Array.from({ length: 60 }, (_, i) => i * 0.43 + 0.2 * rnd())
    beats.sort((x, y) => x - y)
    expect(fitGrid(beats, 0, 30)).toBeNull()
  })
})

describe('beatWarp', () => {
  it('locks B onto A at the grids’ rate, not the plan’s', () => {
    // The analyses' overall BPMs said 142 for both (rateB 1), but around the blend B is at 141 and A at 140.
    const a = frames(grid(140, 200))
    const b = frames(grid(141, 200, 0.3))
    const args = setup(a, b, { rateB: 1 })
    const warp = beatWarp(args)
    expect(warp[0].rate).toBeCloseTo(140 / 141, 3)
    for (let bar = 0; bar <= 8; bar++) {
      const heard = playAt(warp, 0.3 + (bar * 4 * 60) / 141)
      // On A's true beat, not its frame-rounded one.
      const beatA = args.aTimeOf(((64 + bar * 4) * 60) / 140)
      expect(Math.abs(heard - beatA)).toBeLessThan(0.002)
    }
    // After the blend, B goes on at the plan's rate.
    expect(warp[1]).toMatchObject({ t: args.endAt, rate: 1 })
    expect(Math.abs(warp.lock.a.moved)).toBeLessThan(0.011) // off the frame-rounded beat onto the true one
  })

  it('pairs a song heard in half time with two of its beats per beat', () => {
    const a = grid(120, 200)
    const b = grid(60, 100, 0.5)
    const warp = beatWarp(setup(a, b, { rateB: 1 }))
    expect(warp[0].rate).toBeCloseTo(1, 6)
    expect(playAt(warp, b[4])).toBeCloseTo(T + 4, 6)
  })

  it('starts on a true bar where the intro was tracked on the off-beat', () => {
    const a = grid(120, 200)
    const P = 0.5
    const truth = grid(120, 120, 0.3) // B's real beats; bars start on every fourth from 0.3
    // For its first 11 s (no drums yet), the tracker sat half a beat late, beats and downbeats alike.
    const late = (x) => (x < 11 ? x + P / 2 : x)
    const listed = truth.map(late)
    const downbeats = truth.filter((_, i) => i % 4 === 0).map(late)
    const args = {
      ...setup(a, listed),
      inStart: downbeats[1], // a downbeat in the intro, as the planner would pick
      aDownbeats: a.filter((_, i) => i % 4 === 0),
      bDownbeats: downbeats,
    }
    const warp = beatWarp(args)
    expect(warp[0].rate).toBeCloseTo(1, 4)
    // B starts on one of its real bar starts, not the listed one half a beat out.
    const bar = (warp[0].input - 0.3) / (4 * P)
    expect(Math.abs(bar - Math.round(bar))).toBeLessThan(0.002)
    expect(Math.abs(warp.lock.b.moved)).toBeLessThanOrEqual(2 * P + 0.01)
  })

  it('declines when a transition point is not on a beat or tempos do not pair', () => {
    const a = grid(120, 200)
    const b = grid(120, 200)
    expect(beatWarp({ ...setup(a, b), inStart: 0.25 })).toBeNull()
    expect(beatWarp(setup(a, grid(87, 200)))).toBeNull()
    expect(beatWarp(setup(a, grid(120, 10)))).toBeNull()
    expect(beatWarp({ ...setup(a, b), bBeats: [] })).toBeNull()
  })
})

describe('bars', () => {
  it('takes the bar phase most downbeats agree on, and the bar start nearest a time', () => {
    const g = { t0: 0, period: 0.5 }
    // Downbeats on indices 1, 5, 9, ... and one stray on index 2.
    const downbeats = [0.5, 2.5, 4.5, 6.5, 1.0]
    expect(barPhase(g, downbeats, 0, 10)).toBe(1)
    expect(barStart(g, 1, 2.2)).toBeCloseTo(2.5)
    expect(barStart(g, 1, 1.4)).toBeCloseTo(0.5)
    expect(barStart(g, null, 1.4)).toBeCloseTo(1.5)
    expect(barPhase(g, [], 0, 10)).toBeNull()
  })
})

describe('nearestIndex', () => {
  it('finds the nearest value', () => {
    expect(nearestIndex([0, 1, 2, 3], 1.4)).toBe(1)
    expect(nearestIndex([0, 1, 2, 3], 1.6)).toBe(2)
  })
})
