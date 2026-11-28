import { describe, expect, it } from 'vitest'
import { DjEngine } from './engine'
import { FlacFrameScanner, parseFlacHeader } from '../gapless/flacFrames'
import { fakeFetch, fixture, until } from '../gapless/testHelpers'

// 44.1 kHz, 25 s in 4000-sample frames.
const silence = fixture('silence25s.flac')
const RATE = 44100

const samplesIn = (bytes) =>
  new FlacFrameScanner(parseFlacHeader(bytes))
    .finish(bytes)
    .reduce((n, f) => n + f.blockSize, 0)

// An AudioParam that records its automation.
const param = (value) => ({
  value,
  events: [],
  cancelScheduledValues(t) {
    this.events = this.events.filter(([, , at]) => at < t)
  },
  setValueAtTime(v, t) {
    this.events.push(['set', v, t])
  },
  linearRampToValueAtTime(v, t) {
    this.events.push(['ramp', v, t])
  },
  setTargetAtTime(v) {
    this.value = v
  },
})

const audioNode = (params = {}) => ({
  ...params,
  connect() {},
  disconnect() {},
})

class FakeContext {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.currentTime = 0
    this.state = 'running'
    this.destination = {}
  }

  createGain() {
    return audioNode({ gain: param(1) })
  }

  createBiquadFilter() {
    return audioNode({ gain: param(0), frequency: param(350), type: '' })
  }

  createDelay() {
    return audioNode({ delayTime: param(0) })
  }

  createDynamicsCompressor() {
    return audioNode({
      threshold: param(0),
      knee: param(0),
      ratio: param(1),
      attack: param(0),
      release: param(0),
    })
  }

  decodeAudioData(buffer) {
    const length = samplesIn(new Uint8Array(buffer))
    return Promise.resolve({
      numberOfChannels: 1,
      sampleRate: RATE,
      length,
      getChannelData: () => new Float32Array(length),
    })
  }

  resume() {
    this.state = 'running'
    return Promise.resolve()
  }

  suspend() {
    this.state = 'suspended'
    return Promise.resolve()
  }

  close() {}
}

// Stands in for a signalsmith-stretch node: keeps the length of what it was given and every schedule() call.
const fakeStretch = (nodes) => async () => {
  const node = {
    seconds: 0,
    schedules: [],
    connect() {},
    disconnect() {},
    addBuffers: async ([channel]) => {
      node.seconds += channel.length / RATE
      return node.seconds
    },
    dropBuffers: async (to) => {
      if (to === undefined) node.seconds = 0
      return { start: to ?? 0, end: node.seconds }
    },
    schedule: async (seg) => {
      node.schedules.push(seg)
    },
  }
  nodes.push(node)
  return node
}

const setup = () => {
  const contexts = []
  const nodes = []
  const engine = new DjEngine({
    createContext: (rate) => {
      const ctx = new FakeContext(rate)
      contexts.push(ctx)
      return ctx
    },
    createStretch: fakeStretch(nodes),
    fetchFn: (url) => fakeFetch(silence, { chunk: 50000 })(),
    timers: { setInterval: () => 1, clearInterval: () => {} },
  })
  const events = []
  for (const type of ['metadata', 'ready', 'ended', 'error']) {
    engine.on(type, (detail) => events.push([type, detail]))
  }
  // Moves the clock to `t` and lets both decks decode what they will.
  const settled = (deck) =>
    !deck || (deck.node && deck.stream.done && deck.fedAny && !deck.feeding)
  const at = async (t) => {
    contexts[0].currentTime = t
    await until(() => {
      engine.tick()
      return settled(engine.current) && settled(engine.incoming)
    })
    engine.tick()
  }
  return { engine, contexts, nodes, events, at }
}

const track = (key, extra = {}) => ({
  key,
  url: key,
  duration: 25,
  analysis: () => Promise.resolve({ loudness_lufs: -14 }),
  ...extra,
})

// Analyses with beat lists: A at 120 BPM; B at 117.6 as recorded (0.51 s beats), so 120 at the plan's 1.02.
const beatsA = () =>
  Promise.resolve({
    loudness_lufs: -14,
    beats: Array.from({ length: 60 }, (_, i) => i * 0.5),
  })
const beatsB = () =>
  Promise.resolve({
    loudness_lufs: -14,
    beats: Array.from({ length: 60 }, (_, i) => 0.49 + i * 0.51),
  })

const blendPlan = {
  from: 'a',
  songId: 'b',
  transition: {
    type: 'blend',
    outStart: 16,
    outEnd: 20,
    inStart: 1,
    bars: 2,
    beatsPerBar: 4,
    rate: 1.02,
    semitones: 1,
    bassSwapAt: 0.5,
  },
}

const startA = async (h, opts = {}) => {
  h.engine.load(track('a', opts))
  await until(() => h.engine.ready)
  await h.engine.play()
  await until(() => h.engine.current.segment)
}

describe('DjEngine', () => {
  it('loads paused, then plays from the start through a stretch node at rate 1', async () => {
    const h = setup()
    h.engine.load(track('a'))
    await until(() => h.engine.ready)
    expect(h.events.map(([t]) => t)).toEqual(['metadata', 'ready'])
    expect(h.nodes[0].schedules).toHaveLength(0)
    await h.engine.play()
    await until(() => h.nodes[0].schedules.length > 0)
    expect(h.nodes[0].schedules[0]).toMatchObject({
      input: 0,
      rate: 1,
      semitones: 0,
      active: true,
    })
    expect(h.contexts[0].sampleRate).toBe(44100)
    await h.at(5)
    expect(h.engine.currentTime).toBeCloseTo(4.9)
  })

  it('mixes into the next song on the planned downbeat and hands over when the blend is done', async () => {
    const h = setup()
    await startA(h, { analysis: beatsA })
    const t0 = h.engine.current.segment.t0
    h.engine.setNext(track('b', { plan: blendPlan, analysis: beatsB }))
    await h.at(5)
    const b = h.engine.incoming
    expect(b.plan).toBe(blendPlan)
    // B is decoded from the frame holding its first downbeat (1 s), not from the top.
    expect(b.base).toBeCloseTo(44000 / RATE)
    expect(h.engine.mix).toBeNull() // too early to schedule

    await h.at(t0 + 12)
    expect(h.engine.mix).not.toBeNull()
    const bNode = h.nodes[1]
    const start = bNode.schedules.at(-1)
    expect(start.output).toBeCloseTo(t0 + 16)
    expect(start.input).toBeCloseTo(1 - b.base)
    expect(start).toMatchObject({ semitones: 1, active: true })
    expect(start.rate).toBeCloseTo(1.02, 6)
    expect(h.engine.mix.timeline.lock).not.toBeNull()
    expect(b.fader.gain.events[0]).toEqual(['set', 0, start.output])

    await h.at(t0 + 19.9)
    expect(h.engine.currentKey).toBe('a')
    await h.at(t0 + 20)
    expect(h.events.at(-1)).toEqual(['ended', { key: 'a', continued: true }])
    expect(h.engine.currentKey).toBe('b')
    expect(h.engine.currentRate).toBe(1.02)
    expect(h.engine.currentSemitones).toBe(1)
    expect(h.engine.currentTime).toBeCloseTo(1 + 4 * 1.02)
    expect(h.engine.acceptContinuation('b')).toBe(true)
  })

  it('locks a blend onto the beat grids of both songs', async () => {
    const h = setup()
    const beats = Array.from({ length: 50 }, (_, i) => i * 0.5) // 120 BPM
    const analysis = () => Promise.resolve({ loudness_lufs: -14, beats })
    h.engine.load(track('a', { analysis }))
    await until(() => h.engine.ready)
    await h.engine.play()
    await until(() => h.engine.current.segment)
    const t0 = h.engine.current.segment.t0
    // The plan says 1.02 (from overall BPMs), but the beats say both songs are at 120: the warp plays B at 1.
    h.engine.setNext(track('b', { analysis, plan: blendPlan }))
    await h.at(t0 + 12)
    expect(h.engine.mix.timeline.lock).not.toBeNull()
    const segs = h.engine.incoming.segments
    expect(segs.map((s) => s.rate)).toEqual([1, 1.02])
    expect(segs[0].t0).toBeCloseTo(t0 + 16)
    expect(segs[1].t0).toBeCloseTo(t0 + 20)
    expect(segs[1].in0).toBeCloseTo(5)
    expect(h.engine.mix.timeline.lock.b.moved).toBeCloseTo(0, 6)
    // The node holds one future change at most, so it gets each segment once the one before has started.
    const sent = () => h.nodes[1].schedules.filter((x) => x.active).length
    expect(sent()).toBe(1)
    await h.at(t0 + 16.5)
    expect(sent()).toBe(2)
    expect(h.nodes[1].schedules.some((x) => 'outputTime' in x)).toBe(false)
    await h.at(t0 + 20)
    expect(h.engine.currentKey).toBe('b')
    expect(h.engine.currentRate).toBe(1.02)
  })

  it('echoes out instead of blending when the beats cannot be locked', async () => {
    const h = setup()
    await startA(h)
    const t0 = h.engine.current.segment.t0
    // No beats in the analyses to lock: a blend would overlap the songs at an unknown phase.
    h.engine.setNext(track('b', { plan: blendPlan }))
    await h.at(t0 + 12)
    expect(h.engine.mix.timeline.type).toBe('echo')
    const start = h.nodes[1].schedules.at(-1)
    // The cut on the planned downbeat, B a bar later (2 s at 120 BPM), as recorded.
    expect(start.output).toBeCloseTo(t0 + 18)
    expect(start).toMatchObject({ rate: 1, semitones: 0, active: true })
    expect(h.engine.current.fader.gain.events).toContainEqual([
      'ramp',
      0,
      t0 + 16.03,
    ])
    await h.at(t0 + 20)
    expect(h.engine.currentKey).toBe('b')
  })

  it('ignores a plan made for leaving another song, and plays the next song straight after', async () => {
    const h = setup()
    await startA(h)
    const t0 = h.engine.current.segment.t0
    h.engine.setNext(track('b', { plan: { ...blendPlan, from: 'x' } }))
    await h.at(t0 + 16)
    expect(h.engine.mix).toBeNull()
    await h.at(t0 + 22)
    expect(h.engine.mix?.timeline.type).toBe('cut')
    const end = h.engine.current.endAt
    expect(h.nodes[1].schedules.at(-1)).toMatchObject({ input: 0, rate: 1 })
    expect(h.nodes[1].schedules.at(-1).output).toBeCloseTo(end)
    await h.at(end)
    expect(h.events.at(-1)).toEqual(['ended', { key: 'a', continued: true }])
  })

  it('gives up the mix when playback has passed the mix point, and plays the next song after', async () => {
    const h = setup()
    await startA(h)
    const t0 = h.engine.current.segment.t0
    await h.at(t0 + 17)
    h.engine.setNext(track('b', { plan: blendPlan }))
    await h.at(t0 + 17.5)
    expect(h.engine.incoming.planFailed).toBe(true)
    await h.at(t0 + 22)
    expect(h.engine.mix?.timeline.type).toBe('cut')
  })

  it('cancels a scheduled mix on a seek and plans it again', async () => {
    const h = setup()
    await startA(h)
    const t0 = h.engine.current.segment.t0
    h.engine.setNext(track('b', { plan: blendPlan }))
    await h.at(t0 + 12)
    expect(h.engine.mix).not.toBeNull()
    const seeked = h.engine.seek(2)
    await h.at(t0 + 12.1)
    await seeked
    expect(h.engine.mix).toBeNull()
    expect(h.nodes[1].schedules.at(-1)).toMatchObject({ active: false })
    expect(h.engine.current.segment.in0).toBe(2)
  })

  it('ends without a next song like an element would', async () => {
    const h = setup()
    await startA(h)
    const t0 = h.engine.current.segment.t0
    await h.at(t0 + 25.1)
    expect(h.events.at(-1)).toEqual(['ended', { key: 'a', continued: false }])
  })

  it('levels each deck by its measured loudness', async () => {
    const h = setup()
    h.engine.load(
      track('a', { analysis: () => Promise.resolve({ loudness_lufs: -8 }) }),
    )
    await until(() => h.engine.ready)
    expect(h.engine.current.trim.gain.value).toBeCloseTo(10 ** (-6 / 20))
  })
})
