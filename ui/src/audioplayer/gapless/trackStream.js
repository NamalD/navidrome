import { FlacFrameScanner, parseFlacHeader } from './flacFrames'

// Downloads one track as FLAC and indexes its frames as they arrive, so the engine can ask for pieces of it
// ("whole frames from sample N, about M samples long") before the download has finished. The compressed bytes
// are kept for as long as the stream is, which makes seeking back within the track free.
export class TrackStream {
  constructor(
    url,
    { fetchFn = (...args) => fetch(...args), holdAfterSeconds = 3 } = {},
  ) {
    this.url = url // or a function returning a promise of one
    this.fetchFn = fetchFn
    this.holdAfterSeconds = holdAfterSeconds
    this.held = false
    this.release = null
    this.info = null
    this.frames = [] // { start, end, blockSize, sample }
    this.samplesKnown = 0
    this.done = false
    this.error = null
    this.listeners = new Set()
    this.bytes = new Uint8Array(0)
    this.length = 0
    this.controller = null
    this.scanner = null
  }

  get totalSamples() {
    return this.done ? this.samplesKnown : null
  }

  get secondsKnown() {
    return this.info ? this.samplesKnown / this.info.sampleRate : 0
  }

  // Calls `fn` after each batch of new frames, at the end of the download and on error.
  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  notify() {
    this.listeners.forEach((fn) => fn(this))
  }

  // With `hold`, the download pauses once holdAfterSeconds of audio has arrived, until resume().
  start({ hold = false } = {}) {
    if (this.controller) return this
    this.held = hold
    this.controller = new AbortController()
    this.download().catch((e) => {
      if (this.controller.signal.aborted) return
      this.error = e
      this.notify()
    })
    return this
  }

  resume() {
    this.held = false
    if (this.release) this.release()
    this.release = null
    return this
  }

  abort() {
    if (this.controller) this.controller.abort()
    this.resume()
    this.listeners.clear()
  }

  // Not reading the response body makes the browser stop fetching it once its buffers fill.
  async waitWhileHeld() {
    while (this.held && this.secondsKnown >= this.holdAfterSeconds) {
      await new Promise((resolve) => {
        this.release = resolve
      })
    }
  }

  async download() {
    const url = await (typeof this.url === 'function' ? this.url() : this.url)
    const response = await this.fetchFn(url, {
      signal: this.controller.signal,
    })
    if (!response.ok) {
      throw new Error(`stream request failed: HTTP ${response.status}`)
    }
    const expected = Number(response.headers.get('content-length')) || 0
    this.bytes = new Uint8Array(expected || 4 * 1024 * 1024)
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      this.append(value)
      this.index(false)
      await this.waitWhileHeld()
    }
    this.index(true)
    this.done = true
    this.notify()
  }

  append(chunk) {
    if (this.length + chunk.length > this.bytes.length) {
      const grown = new Uint8Array(
        Math.max(this.bytes.length * 2, this.length + chunk.length),
      )
      grown.set(this.bytes.subarray(0, this.length))
      this.bytes = grown
    }
    this.bytes.set(chunk, this.length)
    this.length += chunk.length
  }

  index(final) {
    const view = this.bytes.subarray(0, this.length)
    if (!this.info) {
      this.info = parseFlacHeader(view)
      if (!this.info) {
        if (final) throw new Error('stream ended inside the FLAC header')
        return
      }
      this.scanner = new FlacFrameScanner(this.info)
    }
    const found = final ? this.scanner.finish(view) : this.scanner.scan(view)
    if (!found.length) return
    for (const frame of found) {
      frame.sample = this.samplesKnown
      this.samplesKnown += frame.blockSize
      this.frames.push(frame)
    }
    if (!final) this.notify()
  }

  // Index of the frame that holds `sample`, or -1 if it hasn't arrived yet.
  frameAt(sample) {
    const { frames } = this
    let lo = 0
    let hi = frames.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const f = frames[mid]
      if (sample < f.sample) hi = mid - 1
      else if (sample >= f.sample + f.blockSize) lo = mid + 1
      else return mid
    }
    return -1
  }

  // A decodable FLAC file holding the frames from the one containing `sample`, about `samples` long.
  // Returns null when that much hasn't arrived yet, unless `allowShort` (then whatever has arrived) or the
  // download is complete (then up to the end of the track).
  pieceAt(sample, samples, allowShort = false) {
    const first = this.frameAt(sample)
    if (first < 0) return null
    let last = first
    let count = this.frames[first].blockSize
    while (count < samples && last + 1 < this.frames.length) {
      last++
      count += this.frames[last].blockSize
    }
    if (count < samples && !allowShort && !this.done) return null
    const start = this.frames[first].start
    const end = this.frames[last].end
    const { header } = this.info
    const file = new Uint8Array(header.length + end - start)
    file.set(header)
    file.set(this.bytes.subarray(start, end), header.length)
    return { file, startSample: this.frames[first].sample, samples: count }
  }
}
