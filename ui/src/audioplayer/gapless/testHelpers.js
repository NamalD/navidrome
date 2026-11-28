// Shared by the gapless tests: the FLAC fixtures, a fake fetch and a fake AudioContext.
import fs from 'node:fs'
import path from 'node:path'
import { FlacFrameScanner, parseFlacHeader } from './flacFrames'

// Paths are relative to the ui folder, where the tests run.
export const fixture = (name) =>
  new Uint8Array(
    fs.readFileSync(path.resolve('src/audioplayer/gapless/__fixtures__', name)),
  )

// A fetch that serves `bytes` in chunks of `chunk` bytes, as a network response would.
export const fakeFetch =
  (bytes, { chunk = 1000, length = true } = {}) =>
  async () => {
    let offset = 0
    return {
      ok: true,
      status: 200,
      headers: new Map(
        length ? [['content-length', String(bytes.length)]] : [],
      ),
      body: {
        getReader: () => ({
          read: async () => {
            if (offset >= bytes.length) return { done: true }
            const value = bytes.slice(offset, offset + chunk)
            offset += chunk
            return { done: false, value }
          },
        }),
      },
    }
  }

export const flush = () => new Promise((r) => setTimeout(r, 0))

export const until = async (cond) => {
  for (let i = 0; i < 500 && !cond(); i++) await flush()
}

// Counts the samples in a FLAC file, standing in for decodeAudioData.
const samplesIn = (bytes) => {
  const info = parseFlacHeader(bytes)
  return new FlacFrameScanner(info)
    .finish(bytes)
    .reduce((n, f) => n + f.blockSize, 0)
}

// An AudioContext whose clock the test moves; it records every source started on it.
export class FakeAudioContext {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.currentTime = 0
    this.state = 'running'
    this.destination = {}
    this.started = [] // { when, offset, length, source }
    this.closed = false
  }

  createGain() {
    return {
      context: this,
      gain: {
        value: 1,
        setTargetAtTime(v) {
          this.value = v
        },
      },
      connect() {},
      disconnect() {},
    }
  }

  createBufferSource() {
    const { started } = this
    const source = {
      buffer: null,
      onended: null,
      stopped: false,
      connect() {},
      disconnect() {},
      start(when, offset = 0) {
        started.push({ when, offset, length: source.buffer.length, source })
      },
      stop() {
        source.stopped = true
      },
    }
    return source
  }

  decodeAudioData(buffer) {
    const length = samplesIn(new Uint8Array(buffer))
    return Promise.resolve({ length, duration: length / this.sampleRate })
  }

  resume() {
    this.state = 'running'
    return Promise.resolve()
  }

  suspend() {
    this.state = 'suspended'
    return Promise.resolve()
  }

  close() {
    this.closed = true
  }
}
