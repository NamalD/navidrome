import { describe, expect, it, vi } from 'vitest'
import { TrackStream } from './trackStream'
import { fakeFetch, fixture, flush, until } from './testHelpers'

const tone = fixture('tone.flac')

describe('TrackStream', () => {
  it('indexes the whole track and knows its length once downloaded', async () => {
    for (const length of [true, false]) {
      const s = new TrackStream('x', {
        fetchFn: fakeFetch(tone, { length }),
      }).start()
      await until(() => s.done)
      expect(s.error).toBeNull()
      expect(s.totalSamples).toBe(22050)
      expect(s.info.sampleRate).toBe(44100)
    }
  })

  it('resolves the URL lazily from a function', async () => {
    const fetchFn = vi.fn(fakeFetch(tone))
    const url = vi.fn(async () => '/rest/stream?id=1')
    const s = new TrackStream(url, { fetchFn })
    expect(url).not.toHaveBeenCalled()
    s.start()
    await until(() => s.done)
    expect(fetchFn).toHaveBeenCalledWith('/rest/stream?id=1', expect.anything())
  })

  it('makes pieces of whole frames that start at or before the sample asked for', async () => {
    const s = new TrackStream('x', { fetchFn: fakeFetch(tone) }).start()
    await until(() => s.done)
    const piece = s.pieceAt(5000, 4096)
    expect(piece.startSample).toBe(4096) // the frame holding sample 5000
    expect(piece.samples).toBeGreaterThanOrEqual(4096)
    expect(piece.samples % 1024).toBe(0)
    expect([...piece.file.subarray(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43])
    // the last piece runs to the end of the track
    const last = s.pieceAt(21000, 100000)
    expect(last.startSample + last.samples).toBe(22050)
  })

  it('holds back a piece until enough has arrived, unless short pieces are allowed', () => {
    const s = new TrackStream('x')
    // ffmpeg leaves 8 KiB of padding before the first frame, so take a few frames past that
    s.append(tone.subarray(0, 8192 + 8000))
    s.index(false)
    expect(s.done).toBe(false)
    expect(s.samplesKnown).toBeGreaterThan(0)
    expect(s.pieceAt(0, 22050)).toBeNull()
    expect(s.pieceAt(0, 22050, true).samples).toBe(s.samplesKnown)
  })

  it('pauses a held download once the first seconds are in, until resumed', async () => {
    const s = new TrackStream('x', {
      fetchFn: fakeFetch(tone, { chunk: 500 }),
      holdAfterSeconds: 0.1,
    }).start({ hold: true })
    await until(() => s.secondsKnown >= 0.1)
    // let it run on as far as it would: until it has stopped growing for a while
    for (let last = -1, still = 0; still < 20; ) {
      await flush()
      still = s.length === last ? still + 1 : 0
      last = s.length
    }
    expect(s.done).toBe(false)
    expect(s.length).toBeLessThan(tone.length)
    s.resume()
    await until(() => s.done)
    expect(s.totalSamples).toBe(22050)
  })

  it('reports a failed request', async () => {
    const s = new TrackStream('x', {
      fetchFn: async () => ({ ok: false, status: 403 }),
    })
    const seen = vi.fn()
    s.subscribe(seen)
    s.start()
    await until(() => s.error)
    expect(String(s.error)).toMatch(/HTTP 403/)
    expect(seen).toHaveBeenCalled()
  })
})
