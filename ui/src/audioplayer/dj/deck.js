import { TrackStream } from '../gapless/trackStream'
import { levelFor } from './timeline'

const AHEAD = 30 // seconds of audio decoded and handed to the stretcher ahead of the play position
const FIRST_PIECE = 2 // seconds in the first piece, so playback can start early
const PIECE = 10 // seconds in each later piece
const KEEP_BEHIND = 20 // seconds of played audio kept, so seeking back a little needs no new decode
const BASS_HZ = 200
const ECHO_TONE_HZ = 400

// One song on the mixer: its download (a TrackStream of FLAC), a signalsmith-stretch node that plays it at any
// rate and transposition, and a channel strip: trim (loudness), a low shelf for the bass swap, a fader, and an
// echo send.
//
// The stretch node holds decoded audio in a buffer of its own that only grows at the end, so the deck feeds it
// in order from wherever playback starts. `base` is the song time at the node's input time 0, which moves when
// the deck throws the buffer away to start from somewhere else.
export class Deck {
  constructor(engine, track) {
    this.engine = engine
    this.track = track
    this.key = track.key
    this.stream = new TrackStream(track.url, {
      fetchFn: engine.fetchFn,
      holdAfterSeconds: Infinity,
    }).start()
    this.node = null
    this.base = 0
    this.availableFrom = 0 // song seconds of the oldest audio still in the node
    this.fedSample = 0 // next source sample to decode
    this.fedAny = false
    this.feeding = false
    this.generation = 0
    this.target = 0 // where to start, in song seconds, while not scheduled
    // Once scheduled to play: [{ t0, in0, rate }], each from context time t0 at song time in0, in order
    this.segments = []
    this.unsent = []
    this.lastSent = null
    this.rate = 1
    this.semitones = 0
    this.level = null
    this.plan = null
    this.planFailed = false
    this.metadataSent = false
    this.readySent = false
    this.released = false
    this.offStream = this.stream.subscribe(() => engine.poke())
    this.setup = this.connect().catch((e) => {
      this.error = e
      engine.poke()
    })
  }

  async connect() {
    const { ctx, master } = this.engine
    this.trim = ctx.createGain()
    this.bass = ctx.createBiquadFilter()
    this.bass.type = 'lowshelf'
    this.bass.frequency.value = BASS_HZ
    this.bass.gain.value = 0
    this.fader = ctx.createGain()
    this.fader.gain.value = 1
    this.send = ctx.createGain()
    this.send.gain.value = 0
    this.delay = ctx.createDelay(2)
    this.echoTone = ctx.createBiquadFilter()
    this.echoTone.type = 'highpass'
    this.echoTone.frequency.value = ECHO_TONE_HZ
    this.feedback = ctx.createGain()
    this.feedback.gain.value = 0
    this.trim.connect(this.bass)
    this.bass.connect(this.fader)
    this.fader.connect(master)
    this.bass.connect(this.send)
    this.send.connect(this.delay)
    this.delay.connect(this.echoTone)
    this.echoTone.connect(this.feedback)
    this.feedback.connect(this.delay)
    this.delay.connect(master)

    const [node, analysis] = await Promise.all([
      this.engine.createStretch(ctx),
      Promise.resolve(this.track.analysis?.()).catch(() => null),
    ])
    if (this.released) {
      node.disconnect()
      return
    }
    this.analysis = analysis || null
    this.level = analysis
      ? levelFor(analysis.loudness_lufs)
      : (this.track.gain ?? 1) * levelFor(undefined)
    this.trim.gain.value = this.level
    node.connect(this.trim)
    this.node = node
    this.engine.poke()
  }

  get sampleRate() {
    return this.stream.info?.sampleRate ?? null
  }

  get duration() {
    const { stream } = this
    if (stream.done && stream.info)
      return stream.totalSamples / stream.info.sampleRate
    return this.track.duration ?? NaN
  }

  // Song seconds decoded so far, from availableFrom.
  get fedUntil() {
    return this.sampleRate ? this.fedSample / this.sampleRate : 0
  }

  get fedAll() {
    return this.stream.done && this.fedSample >= this.stream.totalSamples
  }

  // The first segment: where and when the deck started playing (null while it isn't).
  get segment() {
    return this.segments[0] ?? null
  }

  // Song time at context time `now`.
  position(now) {
    const segs = this.segments
    if (segs.length === 0) return this.target
    let s = segs[0]
    for (const seg of segs) if (seg.t0 <= now) s = seg
    return s.in0 + Math.max(0, now - s.t0) * s.rate
  }

  // The context time at which the deck plays song time `songSeconds`.
  timeOf(songSeconds) {
    const segs = this.segments
    let s = segs[0]
    for (const seg of segs) if (seg.in0 <= songSeconds) s = seg
    return s.t0 + (songSeconds - s.in0) / s.rate
  }

  get endAt() {
    if (!this.segment || !this.stream.done || !this.stream.info) return null
    return this.timeOf(this.duration)
  }

  // Whether the deck can start playing song time `songSeconds` now.
  readyAt(songSeconds) {
    if (!this.node || !this.fedAny || this.error) return false
    if (songSeconds < this.availableFrom) return false
    return this.fedAll || this.fedUntil >= songSeconds + FIRST_PIECE
  }

  // Makes sure the node will hold audio from `songSeconds` on: keeps what it has if that covers it, otherwise
  // throws it away and starts decoding from there.
  async cue(songSeconds) {
    this.target = songSeconds
    const covered =
      this.fedAny &&
      songSeconds >= this.availableFrom &&
      songSeconds <= this.fedUntil
    if (covered) return
    if (!this.node) {
      this.restartFrom = songSeconds
      return
    }
    // Reset before the drop is done, and feed nothing until it is, so no piece lands in the node between the two.
    const gen = ++this.generation
    this.fedAny = false
    this.fedSample = Math.round(songSeconds * (this.sampleRate || 44100))
    this.feeding = true
    await this.node.dropBuffers()
    if (gen !== this.generation) return
    this.feeding = false
    this.engine.poke()
  }

  // Decodes pieces ahead of the play position into the node.
  async feed(now) {
    if (this.feeding || this.released || !this.node || this.error) return
    const { stream } = this
    if (stream.error || !stream.info) return
    const rate = stream.info.sampleRate
    if (this.restartFrom !== undefined) {
      this.fedSample = Math.round(this.restartFrom * rate)
      this.restartFrom = undefined
    }
    const gen = this.generation
    this.feeding = true
    try {
      for (;;) {
        if (gen !== this.generation || this.released) return
        if (this.fedAll) return
        const pos = this.position(now())
        if (this.fedAny && this.fedUntil > pos + AHEAD) {
          await this.dropPlayed(pos)
          return
        }
        const size = (this.fedAny ? PIECE : FIRST_PIECE) * rate
        const piece = stream.pieceAt(this.fedSample, size)
        if (!piece) return
        const buffer = await this.engine.ctx.decodeAudioData(piece.file.buffer)
        if (gen !== this.generation || this.released) return
        const channels = []
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          channels.push(buffer.getChannelData(c).slice())
        }
        if (!this.fedAny) {
          this.base = piece.startSample / rate
          this.availableFrom = this.base
          this.fedAny = true
        }
        await this.node.addBuffers(
          channels,
          channels.map((ch) => ch.buffer),
        )
        if (gen !== this.generation) return
        this.fedSample = piece.startSample + piece.samples
        this.engine.poke()
      }
    } catch (e) {
      if (gen === this.generation) {
        this.error = e
        this.engine.poke()
      }
    } finally {
      if (gen === this.generation) this.feeding = false
    }
  }

  async dropPlayed(pos) {
    const keepFrom = pos - KEEP_BEHIND
    if (!this.segments.length || keepFrom - this.availableFrom < PIECE) return
    const range = await this.node.dropBuffers(keepFrom - this.base)
    if (range && Number.isFinite(range.start)) {
      this.availableFrom = this.base + range.start
    }
  }

  // Plays song time `songSeconds` at context time `when`, at `rate`.
  startAt(when, songSeconds, rate = this.rate, semitones = this.semitones) {
    this.segments = []
    this.unsent = []
    this.lastSent = null
    this.semitones = semitones
    this.then(when, songSeconds, rate)
  }

  // From context time `when` (after the last segment), plays on from song time `songSeconds` at `rate`.
  then(when, songSeconds, rate) {
    this.rate = rate
    const seg = { t0: when, in0: songSeconds, rate }
    this.segments.push(seg)
    this.unsent.push(seg)
    this.sendSchedule(this.engine.ctx.currentTime)
  }

  // The stretch node keeps one change in the future at most (scheduling another drops it), so each segment is
  // sent once the one before it has started. The engine calls this every tick.
  sendSchedule(now) {
    while (
      this.unsent.length &&
      (this.lastSent === null || this.lastSent.t0 <= now)
    ) {
      const seg = this.unsent.shift()
      this.lastSent = seg
      this.node.schedule({
        output: seg.t0,
        input: seg.in0 - this.base,
        rate: seg.rate,
        semitones: this.semitones,
        active: true,
      })
    }
  }

  // Stops playing at context time `when` (now if not given), remembering where it was.
  halt(when) {
    const at = when ?? this.engine.ctx.currentTime
    if (this.segments.length) this.target = this.position(at)
    this.segments = []
    this.unsent = []
    this.lastSent = null
    if (this.node) this.node.schedule({ output: at, active: false })
  }

  // Puts the channel strip back to neutral from `when` on: fader at `fader`, full bass, no echo.
  resetStrip(when, fader) {
    for (const [param, value] of [
      [this.fader.gain, fader],
      [this.bass.gain, 0],
      [this.send.gain, 0],
      [this.feedback.gain, 0],
    ]) {
      param.cancelScheduledValues(when)
      param.setValueAtTime(value, when)
    }
  }

  release() {
    if (this.released) return
    this.released = true
    this.generation++
    this.offStream()
    this.stream.abort()
    if (this.node) {
      this.node.dropBuffers()
      this.node.disconnect()
    }
    for (const n of [
      this.trim,
      this.bass,
      this.fader,
      this.send,
      this.delay,
      this.echoTone,
      this.feedback,
    ]) {
      n?.disconnect()
    }
  }
}
