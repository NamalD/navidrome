import { describe, expect, it, vi } from 'vitest'
import { GaplessEngine } from './engine'
import { FakeAudioContext, fakeFetch, fixture, until } from './testHelpers'

const files = {
  a: fixture('tone.flac'), // 44.1 kHz, 22050 samples
  b: fixture('tone.flac'),
  c: fixture('tone48k.flac'), // 48 kHz
  long: fixture('silence25s.flac'), // 44.1 kHz, 25 s in 4000-sample frames
}
const track = (key) => ({ key, url: key, gain: 1 })

const setup = () => {
  const contexts = []
  const engine = new GaplessEngine({
    createContext: (rate) => {
      const ctx = new FakeAudioContext(rate)
      contexts.push(ctx)
      return ctx
    },
    fetchFn: (url) => fakeFetch(files[url])(),
    timers: { setInterval: () => 1, clearInterval: () => {} },
  })
  const events = []
  for (const type of ['metadata', 'ready', 'ended', 'error']) {
    engine.on(type, (detail) => events.push([type, detail]))
  }
  return { engine, contexts, events }
}

// Where, in samples from `t0`, each source on `ctx` starts.
const startSamples = (ctx, t0) =>
  ctx.started.map((s) => (s.when - t0) * ctx.sampleRate)

// Runs the engine's timer until `cond` holds.
const drive = (engine, cond) =>
  until(() => {
    engine.tick()
    return cond()
  })

// Until the current track is downloaded and scheduled to its end.
const settle = (engine) =>
  drive(
    engine,
    () =>
      engine.current?.stream.done &&
      !engine.current.decoding &&
      engine.current.endTime !== null,
  )

describe('GaplessEngine', () => {
  it('loads paused, then plays the track as back-to-back pieces', async () => {
    const { engine, contexts, events } = setup()
    engine.load(track('long'))
    await until(() => engine.ready)
    expect(events.map(([t]) => t)).toEqual(['metadata', 'ready'])
    expect(contexts[0].started).toHaveLength(0) // nothing sounds before play()
    await engine.play()
    const ctx = contexts[0]
    // only about 15 s is scheduled ahead of the play position
    await drive(engine, () => engine.current.nextSample > 15 * 44100)
    expect(engine.current.endTime).toBeNull()
    ctx.currentTime = 12
    await settle(engine)
    const { t0 } = engine.current
    expect(ctx.started[0]).toMatchObject({ when: 0.05, offset: 0 })
    expect(ctx.started.length).toBeGreaterThan(2)
    // every piece starts on the sample after the previous piece's last one
    const starts = startSamples(ctx, t0)
    ctx.started.forEach((s, i) => {
      const expected = i === 0 ? 0 : starts[i - 1] + ctx.started[i - 1].length
      expect(starts[i]).toBeCloseTo(expected, 6)
    })
    const total = ctx.started.reduce((n, s) => n + s.length, 0)
    expect(total).toBe(25 * 44100)
    expect(engine.current.endTime).toBeCloseTo(t0 + 25, 9)
    expect(engine.duration).toBe(25)
  })

  it('starts the next track on the sample after the current one ends', async () => {
    const { engine, contexts, events } = setup()
    engine.load(track('a'))
    engine.setNext(track('b'))
    await engine.play()
    await settle(engine)
    await drive(engine, () => engine.continuation?.sources.size > 0)
    const ctx = contexts[0]
    const { endTime } = engine.current
    const firstOfNext = ctx.started.find(
      (s) => engine.continuation.sources.has(s.source) && s.offset === 0,
    )
    expect(firstOfNext.when).toBe(endTime)

    ctx.currentTime = endTime
    engine.tick()
    expect(events.at(-1)).toEqual(['ended', { key: 'a', continued: true }])
    expect(engine.currentKey).toBe('b')
    expect(engine.acceptContinuation('b')).toBe(true)
    expect(engine.acceptContinuation('b')).toBe(false) // only once
    expect(contexts).toHaveLength(1)
  })

  it('stops at the end when the next track has another sample rate', async () => {
    const { engine, contexts, events } = setup()
    engine.load(track('a'))
    engine.setNext(track('c'))
    await engine.play()
    await settle(engine)
    await drive(engine, () => engine.streams.get('c')?.info)
    expect(engine.continuation).toBeNull()

    contexts[0].currentTime = engine.current.endTime
    engine.tick()
    expect(events.at(-1)).toEqual(['ended', { key: 'a', continued: false }])
    expect(engine.currentKey).toBe('a')
    expect(engine.playing).toBe(false)
    expect(engine.acceptContinuation('c')).toBe(false)

    // the player then loads it, which needs a context at its rate
    engine.load(track('c'))
    await engine.play()
    await drive(
      engine,
      () => contexts.length === 2 && contexts[1].started.length,
    )
    expect(contexts[1].sampleRate).toBe(48000)
    expect(contexts[0].closed).toBe(true)
  })

  it('seeks within the track', async () => {
    const { engine, contexts } = setup()
    engine.load(track('a'))
    await engine.play()
    await settle(engine)
    const ctx = contexts[0]
    const before = ctx.started.map((s) => s.source)
    ctx.currentTime = 0.2
    await engine.seek(0.3)
    expect(before.every((s) => s.stopped)).toBe(true)
    const first = ctx.started[before.length]
    // starts mid-piece at sample 13230; the piece begins at the frame holding it (12 * 1024)
    expect(first.when).toBeCloseTo(0.25, 9)
    expect(first.offset * 44100).toBeCloseTo(13230 - 12 * 1024, 6)
    ctx.currentTime = 0.35
    expect(engine.currentTime).toBeCloseTo(0.4, 9)
  })

  it('reports the position while paused and suspends the context', async () => {
    const { engine, contexts } = setup()
    engine.load(track('a'))
    await engine.play()
    await settle(engine)
    const ctx = contexts[0]
    ctx.currentTime = 0.15
    expect(engine.currentTime).toBeCloseTo(0.1, 9)
    engine.pause()
    expect(ctx.state).toBe('suspended')
    await engine.play()
    expect(ctx.state).toBe('running')
  })

  it('refuses to start audio before the user has used the page', async () => {
    const { engine, contexts } = setup()
    engine.load(track('a'))
    await until(() => engine.ready)
    contexts[0].state = 'suspended'
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: false } })
    try {
      await expect(engine.play()).rejects.toMatchObject({
        name: 'NotAllowedError',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('plays a piece late rather than dropping it when the download falls behind', async () => {
    const { engine, contexts } = setup()
    engine.load(track('long'))
    await until(() => engine.ready)
    await engine.play()
    const ctx = contexts[0]
    ctx.currentTime = 5 // long past the end of the 1.5 s first piece
    await drive(engine, () => ctx.started.length > 1)
    const late = ctx.started[1]
    expect(late.when).toBeCloseTo(5.055, 9)
    // the rest of the track moves with it, still back to back
    expect(late.when - engine.current.t0).toBeCloseTo(
      ctx.started[0].length / 44100,
      9,
    )
  })

  it('reports a stream that fails', async () => {
    const { engine, events } = setup()
    engine.fetchFn = async () => ({ ok: false, status: 500 })
    engine.load(track('a'))
    await until(() => events.length)
    expect(events[0][0]).toBe('error')
  })
})
