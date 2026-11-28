import { describe, expect, it } from 'vitest'
import { FlacFrameScanner, parseFlacHeader } from './flacFrames'
import { fixture as load } from './testHelpers'

// 0.5 s of stereo 44.1 kHz 16-bit tones, 1024-sample frames, with a title tag
const fixture = load('tone.flac')
const TOTAL_SAMPLES = 22050

// Feeds the scanner the way a download arrives: a growing prefix of the file, `step` bytes more each time.
const scanInSteps = (bytes, step) => {
  let info = null
  let scanner = null
  const frames = []
  for (let have = step; ; have = Math.min(bytes.length, have + step)) {
    const view = bytes.subarray(0, have)
    if (!info) {
      info = parseFlacHeader(view)
      if (info) scanner = new FlacFrameScanner(info)
    }
    if (scanner) {
      frames.push(
        ...(have === bytes.length ? scanner.finish(view) : scanner.scan(view)),
      )
    }
    if (have === bytes.length) return { info, frames }
  }
}

describe('parseFlacHeader', () => {
  it('reads the stream format', () => {
    const info = parseFlacHeader(fixture)
    expect(info).toMatchObject({
      sampleRate: 44100,
      channels: 2,
      bitsPerSample: 16,
      minBlockSize: 1024,
      maxBlockSize: 1024,
    })
  })

  it('waits until the whole header has arrived', () => {
    expect(parseFlacHeader(fixture.subarray(0, 3))).toBeNull()
    expect(parseFlacHeader(fixture.subarray(0, 30))).toBeNull()
  })

  it('rejects data that is not FLAC', () => {
    expect(() => parseFlacHeader(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(
      /not a FLAC stream/,
    )
  })

  it('builds a stand-alone header without tags and without the sample count', () => {
    const { header, framesStart } = parseFlacHeader(fixture)
    expect(header.length).toBe(42)
    expect(framesStart).toBeGreaterThan(header.length) // the tags are left out
    expect([...header.subarray(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43])
    expect(header[4]).toBe(0x80) // STREAMINFO, marked as the last block
    expect(header[8 + 13] & 0x0f).toBe(0)
    expect([...header.subarray(8 + 14, 42)].every((b) => b === 0)).toBe(true)
  })
})

describe('FlacFrameScanner', () => {
  it('finds every frame, back to back, covering the whole file', () => {
    const { info, frames } = scanInSteps(fixture, fixture.length)
    expect(frames).toHaveLength(Math.ceil(TOTAL_SAMPLES / 1024))
    expect(frames[0].start).toBe(info.framesStart)
    frames.slice(1).forEach((f, i) => expect(f.start).toBe(frames[i].end))
    expect(frames[frames.length - 1].end).toBe(fixture.length)
    expect(frames.reduce((n, f) => n + f.blockSize, 0)).toBe(TOTAL_SAMPLES)
  })

  it('finds the same frames however the download is split', () => {
    const whole = scanInSteps(fixture, fixture.length).frames
    for (const step of [1, 7, 100, 999, 4096]) {
      expect(scanInSteps(fixture, step).frames).toEqual(whole)
    }
  })

  it('reports a download that stops inside a frame', () => {
    const cut = fixture.subarray(0, fixture.length - 10)
    const info = parseFlacHeader(cut)
    expect(() => new FlacFrameScanner(info).finish(cut)).toThrow(
      /ends inside a frame/,
    )
  })
})
