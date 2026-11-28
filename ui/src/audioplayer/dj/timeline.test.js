import { describe, expect, it } from 'vitest'
import {
  BASS_CUT_DB,
  TARGET_LUFS,
  applyLane,
  levelFor,
  transitionTimeline,
} from './timeline'

const blend = {
  type: 'blend',
  outStart: 200,
  outEnd: 232, // 16 bars at 120 BPM
  inStart: 0.4,
  bars: 16,
  beatsPerBar: 4,
  rate: 1.02,
  semitones: -1,
  bassSwapAt: 0.5,
}

const valueAt = (lane, t) => {
  let v = lane[0][1]
  for (let i = 1; i < lane.length; i++) {
    const [t0, v0] = lane[i - 1]
    const [t1, v1] = lane[i]
    if (t >= t1) v = v1
    else if (t > t0) return v0 + ((t - t0) / (t1 - t0)) * (v1 - v0)
  }
  return v
}

describe('transitionTimeline', () => {
  it('starts the next song on the downbeat and swaps the bass on a bar line', () => {
    const tl = transitionTimeline(blend, { outStartAt: 50, rateA: 1 })
    expect(tl.b).toMatchObject({
      startAt: 50,
      input: 0.4,
      rate: 1.02,
      semitones: -1,
    })
    expect(tl.endAt).toBe(82)
    // B rises over the first half while A holds, then A goes over the second.
    expect(valueAt(tl.b.fader, 50)).toBe(0)
    expect(valueAt(tl.b.fader, 66)).toBeCloseTo(1)
    expect(valueAt(tl.a.fader, 66)).toBe(1)
    expect(valueAt(tl.a.fader, 82)).toBeCloseTo(0)
    // Bass: B's cut until bar 8 (16 s in), then A's.
    expect(valueAt(tl.b.bass, 65.9)).toBe(BASS_CUT_DB)
    expect(valueAt(tl.b.bass, 66.1)).toBe(0)
    expect(valueAt(tl.a.bass, 65.9)).toBe(0)
    expect(valueAt(tl.a.bass, 66.1)).toBe(BASS_CUT_DB)
  })

  it("keeps both faders' power about constant", () => {
    const tl = transitionTimeline(
      { ...blend, type: 'fade', outEnd: 212 },
      { outStartAt: 0 },
    )
    for (let t = 0; t <= 12; t += 1.5) {
      const a = valueAt(tl.a.fader, t)
      const b = valueAt(tl.b.fader, t)
      expect(a * a + b * b).toBeGreaterThan(0.95)
      expect(a * a + b * b).toBeLessThan(1.05)
    }
  })

  it('times everything in A by its playback rate', () => {
    const tl = transitionTimeline(blend, { outStartAt: 10, rateA: 0.8 })
    expect(tl.endAt).toBe(10 + 32 / 0.8)
  })

  it('echoes the last beat out and brings the next song in a bar later', () => {
    const tl = transitionTimeline(
      {
        type: 'echo',
        outStart: 100,
        outEnd: 104,
        inStart: 0.2,
        bars: 2,
        rate: 1,
        echoBeat: 0.5,
      },
      { outStartAt: 20 },
    )
    expect(tl.echoDelay).toBe(0.5)
    expect(valueAt(tl.a.send, 19.4)).toBe(0)
    expect(valueAt(tl.a.send, 19.8)).toBe(1)
    expect(valueAt(tl.a.send, 20.1)).toBe(0)
    expect(valueAt(tl.a.fader, 20.1)).toBe(0)
    expect(tl.b.startAt).toBe(22)
    expect(valueAt(tl.b.fader, 22.1)).toBe(1)
    expect(valueAt(tl.a.feedback, 24)).toBe(0)
  })
})

describe('applyLane', () => {
  it('sets the first point and ramps to the rest', () => {
    const calls = []
    const param = {
      cancelScheduledValues: (t) => calls.push(['cancel', t]),
      setValueAtTime: (v, t) => calls.push(['set', v, t]),
      linearRampToValueAtTime: (v, t) => calls.push(['ramp', v, t]),
    }
    applyLane(param, [
      [1, 0],
      [2, 1],
    ])
    expect(calls).toEqual([
      ['cancel', 1],
      ['set', 0, 1],
      ['ramp', 1, 2],
    ])
  })
})

describe('levelFor', () => {
  it('brings songs to the target loudness, boosting quiet ones only a little', () => {
    expect(levelFor(TARGET_LUFS)).toBe(1)
    expect(levelFor(-8)).toBeCloseTo(10 ** (-6 / 20))
    expect(levelFor(-30)).toBeCloseTo(10 ** (3 / 20))
    expect(levelFor(undefined)).toBeLessThan(1)
  })
})
