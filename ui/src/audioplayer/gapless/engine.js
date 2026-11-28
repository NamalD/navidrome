import { TrackStream } from './trackStream'

// Plays tracks through the Web Audio API so that one track's first sample follows the previous track's last
// sample with nothing in between.
//
// Each track is streamed as FLAC (TrackStream) and decoded a piece at a time; every piece is scheduled on the
// AudioContext clock at the exact time its first sample is due. When a track's download is complete its end
// time is known to the sample, and the next track (setNext) is scheduled to start right then. The context runs
// at the track's sample rate, so the browser never resamples a piece on its own (which would leave a seam at
// each piece boundary); tracks at a different rate from the one playing start on a new context instead.
//
// Events (on/off): 'metadata' and 'ready' for the loaded track (header read; first piece decoded), 'ended'
// when the playing track finishes (then `continued` says whether the next one is already playing), 'progress'
// as data arrives, and 'error'.

const LEAD = 0.05 // seconds between scheduling a start and hearing it
const AHEAD = 15 // seconds of audio kept decoded and scheduled ahead of the play position
const FIRST_PIECE = 1.5 // seconds in the piece that starts playback, so it can start early
const PIECE = 10 // seconds in each later piece
const TICK_MS = 100

class Playback {
  constructor(engine, track, stream) {
    this.track = track
    this.stream = stream
    this.target = 0 // sample to start from
    this.t0 = null // context time at which sample 0 sounds (in the past after a seek)
    this.nextSample = 0 // first sample not yet scheduled
    this.prepared = null // first piece, decoded, waiting for play()
    this.preparing = false
    this.decoding = false
    this.endTime = null
    this.generation = 0
    this.sources = new Set()
    this.gainNode = null
  }

  connect(ctx, destination) {
    if (this.gainNode?.context === ctx) return
    this.gainNode = ctx.createGain()
    this.gainNode.gain.value = this.track.gain ?? 1
    this.gainNode.connect(destination)
  }

  reset(target) {
    this.generation++
    this.sources.forEach((s) => {
      s.onended = null
      try {
        s.stop()
      } catch {
        // never started
      }
      s.disconnect()
    })
    this.sources.clear()
    this.target = target
    this.t0 = null
    this.nextSample = target
    this.prepared = null
    this.preparing = false
    this.decoding = false
    this.endTime = null
  }

  release() {
    this.reset(0)
    if (this.gainNode) this.gainNode.disconnect()
  }
}

export class GaplessEngine {
  constructor({
    createContext = (sampleRate) =>
      new AudioContext({ sampleRate, latencyHint: 'playback' }),
    fetchFn,
    timers = window,
  } = {}) {
    this.createContext = createContext
    this.fetchFn = fetchFn
    this.timers = timers
    this.ctx = null
    this.master = null
    this.volume = 1
    this.current = null
    this.continuation = null
    this.nextTrack = null
    this.streams = new Map()
    this.playing = false
    this.continued = false
    this.listeners = new Map()
    this.tick = this.tick.bind(this)
    this.interval = null
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(fn)
    return () => this.listeners.get(type).delete(fn)
  }

  emit(type, detail) {
    this.listeners.get(type)?.forEach((fn) => fn(detail))
  }

  // --- what the player sees ---

  get currentKey() {
    return this.current?.track.key ?? null
  }

  get sampleRate() {
    return this.current?.stream.info?.sampleRate ?? null
  }

  get duration() {
    const pb = this.current
    if (!pb) return NaN
    const { stream } = pb
    if (stream.done && stream.info)
      return stream.totalSamples / stream.info.sampleRate
    return pb.track.duration ?? NaN
  }

  get currentTime() {
    const pb = this.current
    const rate = pb?.stream.info?.sampleRate
    if (!pb || !rate) return 0
    const target = pb.target / rate
    if (pb.t0 === null || !this.ctx) return target
    const t = this.ctx.currentTime - pb.t0
    if (t < target) return target
    const { duration } = this
    return Number.isFinite(duration) ? Math.min(t, duration) : t
  }

  get bufferedSeconds() {
    return this.current?.stream.secondsKnown ?? 0
  }

  get ready() {
    const pb = this.current
    return !!pb && (pb.prepared !== null || pb.t0 !== null)
  }

  // --- control ---

  // Loads `track` ({ key, url (or a promise of one), gain, duration }) paused at its start.
  load(track) {
    this.continued = false
    this.dropContinuation()
    if (this.current) this.current.release()
    this.playing = false
    // Like an element with preload="metadata": fetch enough to start, and the rest once asked to play.
    this.current = new Playback(
      this,
      track,
      this.streamFor(track, { hold: true }),
    )
    this.prune()
    this.watch(this.current)
    this.prepare(this.current)
    this.ensureTicking()
  }

  // After 'ended' with `continued`, the next track is already playing. The player calls this instead of
  // load() when it moves on to that track, so playback carries on untouched.
  acceptContinuation(key) {
    if (!this.continued || this.currentKey !== key) return false
    this.continued = false
    return true
  }

  async play() {
    this.playing = true
    this.ensureTicking()
    if (this.current) this.current.stream.resume()
    if (this.ctx && this.ctx.state !== 'running') {
      await resumeOrFail(this.ctx)
    }
    const pb = this.current
    if (pb && pb.t0 === null && pb.prepared) this.start(pb)
  }

  pause() {
    this.playing = false
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend()
  }

  // Moves the play position. Resolves once audio from there is decoded (and playing, if not paused).
  seek(seconds) {
    const pb = this.current
    const rate = pb?.stream.info?.sampleRate
    if (!pb || !rate) return Promise.resolve()
    this.continued = false
    this.dropContinuation()
    let target = Math.max(0, Math.round(seconds * rate))
    if (pb.stream.done) target = Math.min(target, pb.stream.totalSamples - 1)
    pb.reset(target)
    pb.stream.resume()
    return new Promise((resolve) => {
      const off = this.on('ready', () => {
        off()
        resolve()
      })
      this.prepare(pb)
    })
  }

  // The track to play after the current one ends, or null for none. Only this track is played gaplessly.
  setNext(track) {
    if (track && this.nextTrack && track.key === this.nextTrack.key) {
      this.nextTrack = { ...this.nextTrack, gain: track.gain }
      if (this.continuation) this.setGain(track.key, track.gain)
      return
    }
    this.dropContinuation()
    this.nextTrack = track
    this.prune()
    this.pump()
  }

  setGain(key, gain) {
    for (const pb of [this.current, this.continuation]) {
      if (pb && pb.track.key === key) {
        pb.track = { ...pb.track, gain }
        if (pb.gainNode) {
          pb.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02)
        }
      }
    }
  }

  setVolume(volume) {
    this.volume = volume
    if (this.master) {
      this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.01)
    }
  }

  stop() {
    this.playing = false
    this.continued = false
    this.dropContinuation()
    if (this.current) this.current.release()
    this.current = null
    this.nextTrack = null
    this.prune()
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend()
  }

  destroy() {
    this.stop()
    if (this.interval) this.timers.clearInterval(this.interval)
    this.interval = null
    if (this.ctx) this.ctx.close()
    this.ctx = null
    this.listeners.clear()
  }

  // --- internals ---

  streamFor(track, { hold = false } = {}) {
    let stream = this.streams.get(track.key)
    if (!stream || stream.error) {
      stream = new TrackStream(track.url, {
        fetchFn: this.fetchFn,
        holdAfterSeconds: FIRST_PIECE * 2,
      })
      this.streams.set(track.key, stream)
    }
    return stream.start({ hold })
  }

  // Keeps only the streams of the tracks in play, so a track isn't downloaded twice when it is next.
  prune() {
    const keep = new Set(
      [this.current, this.continuation]
        .filter(Boolean)
        .map((pb) => pb.track.key),
    )
    if (this.nextTrack) keep.add(this.nextTrack.key)
    for (const [key, stream] of this.streams) {
      if (!keep.has(key)) {
        stream.abort()
        this.streams.delete(key)
      }
    }
  }

  watch(pb) {
    pb.stream.subscribe(() => {
      if (pb !== this.current && pb !== this.continuation) return
      if (pb.stream.error) {
        if (pb === this.current) this.emit('error', pb.stream.error)
        else this.dropContinuation()
        return
      }
      if (pb === this.current) this.emit('progress')
      if (pb.preparing === false && pb.prepared === null && pb.t0 === null) {
        this.prepare(pb)
      }
      this.pump()
    })
  }

  ensureContext(sampleRate) {
    if (this.ctx && this.ctx.sampleRate === sampleRate) return
    if (this.ctx) this.ctx.close()
    this.ctx = this.createContext(sampleRate)
    this.master = this.ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(this.ctx.destination)
  }

  // Decodes the piece the current track starts (or restarts after a seek) from.
  async prepare(pb) {
    const { stream } = pb
    if (pb.preparing || pb.prepared || pb.t0 !== null || !stream.info) return
    const first = !this.metadataSent(pb)
    if (first) this.emit('metadata')
    const rate = stream.info.sampleRate
    const piece = stream.pieceAt(pb.target, FIRST_PIECE * rate)
    if (!piece) {
      if (stream.done && pb.target >= stream.samplesKnown) this.emit('ready')
      return
    }
    this.ensureContext(rate)
    pb.connect(this.ctx, this.master)
    pb.preparing = true
    const gen = pb.generation
    let buffer
    try {
      buffer = await this.ctx.decodeAudioData(piece.file.buffer)
    } catch (e) {
      if (gen === pb.generation && pb === this.current) this.emit('error', e)
      return
    }
    if (gen !== pb.generation || pb !== this.current) return
    pb.preparing = false
    pb.prepared = {
      buffer,
      startSample: piece.startSample,
      samples: piece.samples,
    }
    this.emit('ready')
    if (this.playing) this.start(pb)
  }

  metadataSent(pb) {
    if (pb.metadataSent) return true
    pb.metadataSent = true
    return false
  }

  start(pb) {
    const { prepared, stream } = pb
    if (!prepared || !this.ctx) return
    const rate = stream.info.sampleRate
    const when = this.ctx.currentTime + LEAD
    pb.t0 = when - pb.target / rate
    pb.prepared = null
    this.schedule(
      pb,
      prepared.buffer,
      when,
      (pb.target - prepared.startSample) / rate,
    )
    pb.nextSample = prepared.startSample + prepared.samples
    this.pump()
  }

  schedule(pb, buffer, when, offset) {
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(pb.gainNode)
    source.onended = () => {
      pb.sources.delete(source)
      source.disconnect()
    }
    pb.sources.add(source)
    source.start(when, offset)
  }

  // Schedules decoded pieces up to AHEAD seconds out, works out where the track ends, and lines the next
  // track up behind it.
  pump() {
    const pb = this.current
    if (!pb || !this.ctx) return
    this.fill(pb)
    // Start downloading the next track once this one is in, so its first piece is ready well before the end.
    if (pb.stream.done && this.nextTrack)
      this.streamFor(this.nextTrack).resume()
    if (pb.endTime !== null && this.nextTrack && !this.continuation) {
      this.lineUpNext(pb)
    }
    if (this.continuation) this.fill(this.continuation)
  }

  lineUpNext(pb) {
    const next = this.nextTrack
    const stream = this.streamFor(next).resume()
    if (stream.error || !stream.info) return
    // A different sample rate needs a new context; that track starts normally when the player loads it.
    if (stream.info.sampleRate !== this.ctx.sampleRate) return
    const cont = new Playback(this, next, stream)
    cont.metadataSent = true
    cont.connect(this.ctx, this.master)
    cont.t0 = pb.endTime
    this.continuation = cont
    this.watch(cont)
  }

  async fill(pb) {
    if (pb.t0 === null || pb.decoding || pb.stream.error) return
    const { stream } = pb
    const rate = stream.info.sampleRate
    while (pb.t0 !== null) {
      if (stream.done && pb.nextSample >= stream.totalSamples) {
        pb.endTime = pb.t0 + stream.totalSamples / rate
        return
      }
      if (pb.t0 + pb.nextSample / rate > this.ctx.currentTime + AHEAD) return
      const piece = stream.pieceAt(pb.nextSample, PIECE * rate)
      if (!piece) return
      pb.decoding = true
      const gen = pb.generation
      let buffer
      try {
        buffer = await this.ctx.decodeAudioData(piece.file.buffer)
      } catch (e) {
        pb.decoding = false
        if (gen === pb.generation && pb === this.current) this.emit('error', e)
        return
      }
      pb.decoding = false
      if (
        gen !== pb.generation ||
        (pb !== this.current && pb !== this.continuation)
      ) {
        return
      }
      let when = pb.t0 + piece.startSample / rate
      const earliest = this.ctx.currentTime + 0.005
      if (when < earliest) {
        // The download fell behind playback: start this piece a little late rather than drop it.
        const delay = earliest + LEAD - when
        pb.t0 += delay
        when += delay
      }
      this.schedule(pb, buffer, when, 0)
      pb.nextSample = piece.startSample + piece.samples
    }
  }

  dropContinuation() {
    if (!this.continuation) return
    this.continuation.release()
    this.continuation = null
  }

  ensureTicking() {
    if (!this.interval)
      this.interval = this.timers.setInterval(this.tick, TICK_MS)
  }

  tick() {
    const pb = this.current
    if (!pb || !this.ctx) return
    this.pump()
    if (pb.endTime === null || this.ctx.currentTime < pb.endTime) return
    // The current track has played to its end.
    const next = this.continuation
    const continued = next !== null && next.t0 !== null && next.sources.size > 0
    if (continued) {
      this.continuation = null
      this.nextTrack = null
      this.current = next
      this.continued = true
      pb.release()
      this.prune()
    } else {
      this.dropContinuation()
      pb.endTime = null
      pb.t0 = null
      pb.target = pb.stream.totalSamples
      this.playing = false
    }
    this.emit('ended', { key: pb.track.key, continued })
  }
}

// Starts a suspended context. Browsers only let audio start once the user has interacted with the page; until
// then resume() never settles, so that case is reported as an error the way a blocked play() would be. Otherwise
// it waits as long as the output device takes to start (a Bluetooth headset can take seconds).
const resumeOrFail = (ctx) => {
  const activation = navigator.userActivation
  if (activation && !activation.hasBeenActive) {
    const error = new Error('the browser did not allow audio to start')
    error.name = 'NotAllowedError'
    return Promise.reject(error)
  }
  return ctx.resume()
}
