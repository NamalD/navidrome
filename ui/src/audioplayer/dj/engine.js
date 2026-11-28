import { Deck } from './deck'
import { applyLane, transitionTimeline } from './timeline'
import { beatWarp } from './warp'

// Mixes songs into one another like a DJ, through the Web Audio API: two decks (deck.js), each a
// signalsmith-stretch node, so the incoming song can play at the tempo and in the key the planner asks for. It
// has the GaplessEngine's interface, so the same <audio> facade (gapless/mediaFacade.js) puts it behind the
// player: the player sees one song after another, and 'ended' with `continued` once a mix into the next one is
// done.
//
// The next song comes with a plan (track.plan, from GET /api/dj/next): a transition type and its times in each
// song. When the playing song nears plan.outStart, the engine starts the next deck so that its plan.inStart lands
// exactly then, and automates both channel strips (timeline.js). Without a plan, or if the next song isn't
// decoded in time, it plays the next song straight after this one.
//
// Every stream is 44.1 kHz FLAC (the session asks the server for that), so the context runs at 44.1 kHz and
// nothing is resampled.

export const SAMPLE_RATE = 44100
const LEAD = 0.1 // seconds between scheduling a start and hearing it
// A blend's echo-out stand-in (see core/djmix): two bars from the same downbeat, the next song coming in as
// recorded a bar after the cut.
const echoInstead = (tr) => {
  const bar = (tr.outEnd - tr.outStart) / (tr.bars || 1)
  return {
    ...tr,
    type: 'echo',
    outEnd: tr.outStart + 2 * bar,
    bars: 2,
    rate: 1,
    semitones: 0,
    echoBeat: bar / (tr.beatsPerBar || 4),
  }
}

const MIX_AHEAD = 6 // seconds before a transition at which it is scheduled
const TICK_MS = 100

const loadStretch = async () => {
  const mod = await import('./vendor/SignalsmithStretch.mjs')
  return mod.default
}

export class DjEngine {
  constructor({
    createContext = (sampleRate) =>
      new AudioContext({ sampleRate, latencyHint: 'playback' }),
    createStretch,
    fetchFn,
    timers = window,
  } = {}) {
    this.createContext = createContext
    this.createStretch =
      createStretch ||
      (async (ctx) => {
        const SignalsmithStretch = await loadStretch()
        return SignalsmithStretch(ctx)
      })
    this.fetchFn = fetchFn
    this.timers = timers
    this.ctx = null
    this.master = null
    this.volume = 1
    this.current = null
    this.incoming = null
    this.mix = null
    this.playing = false
    this.continued = false
    this.listeners = new Map()
    this.tick = this.tick.bind(this)
    this.interval = null
    this.poking = false
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
    return this.current?.key ?? null
  }

  get duration() {
    return this.current ? this.current.duration : NaN
  }

  get currentTime() {
    const deck = this.current
    if (!deck || !this.ctx) return 0
    const t = deck.position(this.ctx.currentTime)
    const { duration } = deck
    return Number.isFinite(duration) ? Math.min(t, duration) : t
  }

  get bufferedSeconds() {
    return this.current?.stream.secondsKnown ?? 0
  }

  get ready() {
    const deck = this.current
    return !!deck && (deck.segment !== null || deck.readyAt(deck.target))
  }

  // The playing song's tempo change and transposition, for planning the next transition from it.
  get currentRate() {
    return this.current?.rate ?? 1
  }

  get currentSemitones() {
    return this.current?.semitones ?? 0
  }

  // What the mixer is doing, for the UI: null, or { type, from, to, endAt } while a transition is scheduled.
  get mixing() {
    if (!this.mix) return null
    const { deck, timeline } = this.mix
    return {
      type: timeline.type,
      from: this.current?.key,
      to: deck.key,
      startsIn: Math.max(0, timeline.b.startAt - this.ctx.currentTime),
    }
  }

  // --- control ---

  // Loads `track` ({ key, url, gain, duration, analysis, plan }) paused at its start.
  load(track) {
    this.continued = false
    this.ensureContext()
    this.cancelMix()
    let deck
    if (this.incoming && this.incoming.key === track.key) {
      // Already downloading as the next song: start it from the top.
      deck = this.incoming
      this.incoming = null
      deck.halt()
      deck.resetStrip(this.ctx.currentTime, 1)
      deck.cue(0)
    } else {
      deck = new Deck(this, track)
    }
    if (this.current) this.current.release()
    this.current = deck
    this.playing = false
    this.ensureTicking()
    this.poke()
  }

  acceptContinuation(key) {
    if (!this.continued || this.currentKey !== key) return false
    this.continued = false
    return true
  }

  async play() {
    this.playing = true
    this.ensureTicking()
    if (this.ctx && this.ctx.state !== 'running') {
      await resumeOrFail(this.ctx)
    }
    this.poke()
  }

  pause() {
    this.playing = false
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend()
  }

  seek(seconds) {
    const deck = this.current
    if (!deck || !this.ctx) return Promise.resolve()
    this.continued = false
    this.cancelMix()
    if (this.incoming) this.incoming.planFailed = false
    deck.halt()
    deck.resetStrip(this.ctx.currentTime, 1)
    deck.readySent = false
    let target = Math.max(0, seconds)
    if (Number.isFinite(deck.duration)) target = Math.min(target, deck.duration)
    deck.cue(target)
    return new Promise((resolve) => {
      const off = this.on('ready', () => {
        off()
        resolve()
      })
      this.poke()
    })
  }

  // The song to mix into after the current one, with its plan (or null for none).
  setNext(track) {
    const inc = this.incoming
    if (track && inc && inc.key === track.key) {
      inc.track = { ...inc.track, ...track }
      const plan = this.planFor(track)
      if (!this.mix && plan !== inc.plan) {
        inc.plan = plan
        inc.planFailed = false
        inc.cue(plan ? plan.transition.inStart : 0)
      }
      return
    }
    this.cancelMix()
    if (inc) inc.release()
    this.incoming = null
    if (!track || !this.ctx) return
    const deck = new Deck(this, track)
    deck.fader.gain.value = 0
    deck.plan = this.planFor(track)
    deck.cue(deck.plan ? deck.plan.transition.inStart : 0)
    this.incoming = deck
    this.poke()
  }

  // The track's plan, if it is one for leaving the song now playing.
  planFor(track) {
    const plan = track?.plan
    if (!plan || plan.from !== this.currentKey) return null
    return plan
  }

  setGain(key, gain) {
    // Decks are levelled by their measured loudness; ReplayGain only counts for songs never analysed.
    for (const deck of [this.current, this.incoming]) {
      if (deck && deck.key === key && !deck.analysis && deck.trim) {
        deck.track = { ...deck.track, gain }
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
    this.cancelMix()
    for (const deck of [this.current, this.incoming]) deck?.release()
    this.current = null
    this.incoming = null
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

  ensureContext() {
    if (this.ctx) return
    this.ctx = this.createContext(SAMPLE_RATE)
    this.master = this.ctx.createGain()
    this.master.gain.value = this.volume
    // A safety net for the moments two songs overlap: it only acts on peaks above -1 dBFS.
    this.limiter = this.ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -1
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.25
    this.master.connect(this.limiter)
    this.limiter.connect(this.ctx.destination)
  }

  ensureTicking() {
    if (!this.interval)
      this.interval = this.timers.setInterval(this.tick, TICK_MS)
  }

  // Runs a tick soon, after whatever is happening now (a decode finishing, a call from the player).
  poke() {
    if (this.poking) return
    this.poking = true
    Promise.resolve().then(() => {
      this.poking = false
      this.tick()
    })
  }

  now = () => this.ctx.currentTime

  tick() {
    const deck = this.current
    if (!deck || !this.ctx) return
    deck.feed(this.now)
    this.incoming?.feed(this.now)
    const t = this.ctx.currentTime
    if (deck.node) deck.sendSchedule(t)
    if (this.incoming?.node) this.incoming.sendSchedule(t)

    if (deck.stream.error || deck.error) {
      if (!deck.errorSent) {
        deck.errorSent = true
        this.emit('error', deck.stream.error || deck.error)
      }
      return
    }
    if (!deck.metadataSent && deck.stream.info) {
      deck.metadataSent = true
      this.emit('metadata')
    }
    if (!deck.segment) {
      if (!deck.readyAt(deck.target)) return
      if (!deck.readySent) {
        deck.readySent = true
        this.emit('ready')
      }
      if (!this.playing || this.ctx.state !== 'running') return
      deck.startAt(this.ctx.currentTime + LEAD, deck.target)
      return
    }

    const now = this.ctx.currentTime
    const inc = this.incoming
    if (inc && (inc.stream.error || inc.error)) {
      inc.release()
      this.incoming = null
    } else if (inc && !this.mix) {
      this.lineUp(deck, inc, now)
    }

    if (this.mix && now >= this.mix.timeline.endAt) {
      this.handOver()
      return
    }
    const endAt = deck.endAt
    if (!this.mix && endAt !== null && now >= endAt) {
      // Played to the end with nothing mixed in.
      deck.halt(endAt)
      deck.target = deck.duration
      this.playing = false
      this.emit('ended', { key: deck.key, continued: false })
    }
  }

  // Schedules the transition into `inc` once it is near, or the next song straight after this one.
  lineUp(deck, inc, now) {
    const plan = inc.planFailed ? null : inc.plan
    if (plan) {
      const tr = plan.transition
      const at = deck.timeOf(tr.outStart)
      if (at - now > MIX_AHEAD) return
      if (at - now >= LEAD * 2 && inc.readyAt(tr.inStart)) {
        let timeline = transitionTimeline(tr, {
          outStartAt: at,
          rateA: deck.rate,
        })
        let warp = null
        if (timeline.type === 'blend') {
          warp = this.lockBeats(deck, inc, timeline)
          // Beats that can't be locked would blend at an unknown phase for the whole overlap: echo out instead.
          if (!warp) {
            timeline = transitionTimeline(echoInstead(tr), {
              outStartAt: at,
              rateA: deck.rate,
            })
          }
        }
        this.startMix(deck, inc, timeline, warp)
        return
      }
      if (at - now < LEAD * 2) {
        // Too late to mix (the next song wasn't decoded in time, or playback jumped past the mix point).
        inc.planFailed = true
        inc.cue(0)
      }
      return
    }
    const endAt = deck.endAt
    if (endAt === null || endAt - now > MIX_AHEAD || !inc.readyAt(0)) return
    const startAt = Math.max(endAt, now + LEAD)
    this.startMix(deck, inc, {
      type: 'cut',
      endAt: startAt,
      a: {},
      b: { startAt, input: 0, rate: 1, semitones: 0, fader: [[startAt, 1]] },
    })
  }

  // The incoming deck's schedule that locks a blend onto the beats (warp.js), or null.
  lockBeats(deck, inc, timeline) {
    return beatWarp({
      aBeats: deck.analysis?.beats,
      bBeats: inc.analysis?.beats,
      aDownbeats: deck.analysis?.downbeats,
      bDownbeats: inc.analysis?.downbeats,
      outStart: timeline.outStart,
      inStart: timeline.b.input,
      endAt: timeline.endAt,
      aTimeOf: (x) => deck.timeOf(x),
      rateA: deck.rate,
      rateB: timeline.b.rate,
    })
  }

  startMix(deck, inc, timeline, warp = null) {
    const { a, b } = timeline
    if (warp) {
      inc.startAt(warp[0].t, warp[0].input, warp[0].rate, b.semitones)
      for (const w of warp.slice(1)) inc.then(w.t, w.input, w.rate)
    } else {
      inc.startAt(b.startAt, b.input, b.rate, b.semitones)
    }
    timeline.lock = warp?.lock ?? null
    if (timeline.type !== 'cut') {
      const ms = (x) => `${Math.round(x * 1000)} ms`
      // eslint-disable-next-line no-console
      console.log(
        `DJ mix: ${timeline.type}`,
        warp
          ? `locked, rate ${warp[0].rate.toFixed(4)} (plan ${b.rate.toFixed(4)}); grids ${warp.lock.a.n}/${warp.lock.b.n} beats, moved ${ms(warp.lock.a.moved)}/${ms(warp.lock.b.moved)}`
          : '',
      )
    }
    applyLane(inc.fader.gain, b.fader)
    applyLane(inc.bass.gain, b.bass)
    if (timeline.echoDelay) {
      // An echo of one beat; a DelayNode holds at most 2 s, so very slow songs echo every half beat.
      let delay = timeline.echoDelay
      while (delay > 2) delay /= 2
      deck.delay.delayTime.setValueAtTime(delay, this.ctx.currentTime)
    }
    applyLane(deck.fader.gain, a.fader)
    applyLane(deck.bass.gain, a.bass)
    applyLane(deck.send.gain, a.send)
    applyLane(deck.feedback.gain, a.feedback)
    this.mix = { deck: inc, timeline }
  }

  cancelMix() {
    const { mix } = this
    if (!mix) return
    this.mix = null
    const now = this.ctx.currentTime
    mix.deck.halt(now)
    mix.deck.resetStrip(now, 0)
    if (this.current) this.current.resetStrip(now, 1)
    mix.deck.cue(mix.deck.plan ? mix.deck.plan.transition.inStart : 0)
  }

  handOver() {
    const from = this.current
    const { deck } = this.mix
    this.mix = null
    this.incoming = null
    from.release()
    deck.resetStrip(this.ctx.currentTime, 1)
    this.current = deck
    deck.metadataSent = true
    deck.readySent = true
    this.continued = true
    this.emit('ended', { key: from.key, continued: true })
  }
}

// As GaplessEngine: browsers only let audio start once the user has interacted with the page.
const resumeOrFail = (ctx) => {
  const activation = navigator.userActivation
  if (activation && !activation.hasBeenActive) {
    const error = new Error('the browser did not allow audio to start')
    error.name = 'NotAllowedError'
    return Promise.reject(error)
  }
  return ctx.resume()
}
