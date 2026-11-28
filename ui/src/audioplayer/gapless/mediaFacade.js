// Makes the music player library's <audio> element a front for the GaplessEngine.
//
// The library (navidrome-music-player) renders its own <audio>, drives it (src, load, play, pause,
// currentTime, volume) and listens to its events; so does the rest of the player (lyrics, hotkeys, playback
// reports). Rather than fork the library, this replaces those properties and methods on that one element with
// versions backed by the engine, and fires the events an element would. The element itself then never loads
// anything: a capturing listener stops its own media events before the library's listeners see them, and lets
// the ones fired here through.
//
// Songs go to the engine. Anything else (internet radio) is left to the element as before, so the overrides
// hand back to the real implementation for it.

const SYNTHETIC = Symbol('gapless')

const MEDIA_EVENTS = [
  'abort',
  'canplay',
  'canplaythrough',
  'durationchange',
  'emptied',
  'ended',
  'error',
  'loadeddata',
  'loadedmetadata',
  'loadstart',
  'pause',
  'play',
  'playing',
  'progress',
  'ratechange',
  'seeked',
  'seeking',
  'stalled',
  'suspend',
  'timeupdate',
  'volumechange',
  'waiting',
]

const HAVE_NOTHING = 0
const HAVE_METADATA = 1
const HAVE_ENOUGH_DATA = 4
const NETWORK_EMPTY = 0
const NETWORK_IDLE = 1
const NETWORK_LOADING = 2
const MEDIA_ERR_NETWORK = 2

const TIMEUPDATE_MS = 250

const nativeProp = (name) => {
  let proto = HTMLMediaElement.prototype
  while (proto) {
    const d = Object.getOwnPropertyDescriptor(proto, name)
    if (d) return d
    proto = Object.getPrototypeOf(proto)
  }
  return undefined
}

const timeRanges = (end) => ({
  length: end > 0 ? 1 : 0,
  start: () => 0,
  end: () => end,
})

// `resolveTrack(src)` returns the engine track for a stream URL ({ key, url, gain, duration }), or null when
// the element should play it itself. `keeper` (optional) is played and paused along with the engine so the
// browser treats the page as playing media (lock screen and media key controls, background playback).
export const attachGaplessFacade = (el, engine, { resolveTrack, keeper }) => {
  const native = {}
  for (const name of [
    'src',
    'currentSrc',
    'currentTime',
    'duration',
    'paused',
    'ended',
    'seeking',
    'readyState',
    'networkState',
    'buffered',
    'error',
    'volume',
    'muted',
    'playbackRate',
  ]) {
    native[name] = nativeProp(name)
  }
  const nativePlay = HTMLMediaElement.prototype.play
  const nativePause = HTMLMediaElement.prototype.pause
  const nativeLoad = HTMLMediaElement.prototype.load
  const nativeSetAttribute = Element.prototype.setAttribute
  const nativeRemoveAttribute = Element.prototype.removeAttribute
  const nativeGetAttribute = Element.prototype.getAttribute

  const state = {
    mode: 'native',
    src: '',
    track: null,
    paused: true,
    ended: false,
    seeking: false,
    readyState: HAVE_NOTHING,
    networkState: NETWORK_EMPTY,
    error: null,
    volume: native.volume.get.call(el),
    muted: false,
    timer: null,
    pendingPlay: null,
    autoLoaded: false,
    // The engine went straight on into the next track (or, repeating one, into this one again).
    carriedOn: false,
  }

  const emit = (type) => {
    const event = new Event(type)
    event[SYNTHETIC] = true
    el.dispatchEvent(event)
  }
  const emitLater = (...types) =>
    setTimeout(() => types.forEach((t) => emit(t)), 0)

  const guard = (event) => {
    if (state.mode === 'engine' && !event[SYNTHETIC]) {
      event.stopImmediatePropagation()
    }
  }
  MEDIA_EVENTS.forEach((type) => el.addEventListener(type, guard, true))

  const isEngine = () => state.mode === 'engine'

  const applyVolume = () => {
    engine.setVolume(state.muted ? 0 : state.volume)
  }

  const startTimer = () => {
    if (state.timer) return
    state.timer = setInterval(() => emit('timeupdate'), TIMEUPDATE_MS)
  }
  const stopTimer = () => {
    clearInterval(state.timer)
    state.timer = null
  }

  // Drops whatever the element itself had loaded and stops it from loading more.
  const silenceNative = () => {
    nativePause.call(el)
    if (nativeGetAttribute.call(el, 'src') !== null) {
      nativeRemoveAttribute.call(el, 'src')
      nativeLoad.call(el)
    }
  }

  const setSrc = (value) => {
    const src = value == null ? '' : String(value)
    const track = src ? resolveTrack(src) : null
    if (track) {
      if (!isEngine()) {
        state.mode = 'engine'
        silenceNative()
      }
      const changed = src !== state.src
      state.src = src
      state.track = track
      // Setting src on an element starts loading it; the library relies on that for a new queue. When it
      // also calls load() itself straight after, that second load must not restart the track.
      if (changed) {
        load()
        state.autoLoaded = true
        setTimeout(() => {
          state.autoLoaded = false
        }, 0)
      }
    } else {
      if (isEngine()) {
        engine.stop()
        stopTimer()
        if (keeper) keeper.pause()
        state.mode = 'native'
      }
      state.src = src
      state.track = null
      if (src) nativeSetAttribute.call(el, 'src', src)
      else nativeRemoveAttribute.call(el, 'src')
    }
  }

  const load = () => {
    if (!isEngine()) return nativeLoad.call(el)
    if (state.autoLoaded) {
      state.autoLoaded = false
      return undefined
    }
    const { track } = state
    state.ended = false
    state.error = null
    state.carriedOn = false
    if (track && engine.acceptContinuation(track.key)) {
      // The engine already went on to this track when the last one ended.
      state.readyState = HAVE_ENOUGH_DATA
      state.networkState = NETWORK_LOADING
      emitLater(
        'loadstart',
        'durationchange',
        'loadedmetadata',
        'loadeddata',
        'canplay',
        'canplaythrough',
      )
      return undefined
    }
    if (!state.paused) {
      state.paused = true
      stopTimer()
    }
    state.readyState = HAVE_NOTHING
    state.networkState = track ? NETWORK_LOADING : NETWORK_EMPTY
    if (!track) {
      engine.stop()
      emitLater('emptied')
      return undefined
    }
    engine.load(track)
    emitLater('loadstart')
    return undefined
  }

  const play = () => {
    if (!isEngine()) return nativePlay.call(el)
    if (!state.track) {
      const error = new Error('no song loaded')
      error.name = 'NotSupportedError'
      return Promise.reject(error)
    }
    if (state.ended) {
      state.ended = false
      // Repeating one track, the engine is already playing it again from the start.
      if (state.carriedOn) engine.acceptContinuation(state.track.key)
      else engine.seek(0)
    }
    state.carriedOn = false
    if (!state.paused && state.pendingPlay) return state.pendingPlay
    if (!state.paused) return Promise.resolve()
    state.paused = false
    emitLater('play')
    if (keeper) keeper.play()
    const attempt = engine.play().then(
      () => {
        if (state.pendingPlay !== attempt) return
        state.pendingPlay = null
        startTimer()
        // after the 'play' queued above, as an element orders them
        emitLater('playing')
      },
      (error) => {
        if (state.pendingPlay !== attempt) return
        state.pendingPlay = null
        state.paused = true
        if (keeper) keeper.pause()
        emit('pause')
        throw error
      },
    )
    state.pendingPlay = attempt
    return attempt
  }

  const pause = () => {
    if (!isEngine()) return nativePause.call(el)
    if (state.paused) return undefined
    state.paused = true
    state.pendingPlay = null
    engine.pause()
    stopTimer()
    if (keeper) keeper.pause()
    emitLater('timeupdate', 'pause')
    return undefined
  }

  const seek = (seconds) => {
    if (!Number.isFinite(seconds)) return
    // Repeating one track, the player rewinds it before playing it again; the engine already started it over.
    if (state.carriedOn && seconds === 0) return
    state.seeking = true
    state.ended = false
    emit('seeking')
    engine.seek(seconds).then(() => {
      state.seeking = false
      emit('timeupdate')
      emit('seeked')
    })
  }

  const offEngine = [
    engine.on('metadata', () => {
      if (!isEngine()) return
      state.readyState = Math.max(state.readyState, HAVE_METADATA)
      emit('durationchange')
      emit('loadedmetadata')
    }),
    engine.on('ready', () => {
      if (!isEngine() || state.readyState === HAVE_ENOUGH_DATA) return
      state.readyState = HAVE_ENOUGH_DATA
      emit('loadeddata')
      emit('canplay')
      emit('canplaythrough')
    }),
    engine.on('progress', () => {
      if (isEngine()) emit('progress')
    }),
    engine.on('ended', ({ continued }) => {
      if (!isEngine()) return
      // As an element does at the end: a last timeupdate, then pause, then ended. With `continued` the next
      // track is already sounding; the library moves on to it and load() picks it up.
      emit('timeupdate')
      state.paused = true
      state.ended = true
      state.carriedOn = continued
      stopTimer()
      if (!continued && keeper) keeper.pause()
      emit('pause')
      emit('ended')
    }),
    engine.on('error', (error) => {
      if (!isEngine()) return
      state.error = {
        code: MEDIA_ERR_NETWORK,
        message: String(error?.message || error),
      }
      state.networkState = NETWORK_IDLE
      emit('error')
    }),
  ]

  const define = (name, get, set) => {
    Object.defineProperty(el, name, {
      configurable: true,
      get() {
        return isEngine() ? get() : native[name].get.call(el)
      },
      set(value) {
        if (isEngine() && set) set(value)
        else if (native[name].set) native[name].set.call(el, value)
      },
    })
  }

  define('currentSrc', () => state.src)
  define(
    'currentTime',
    () => engine.currentTime,
    (v) => seek(Number(v)),
  )
  define('duration', () =>
    state.readyState >= HAVE_METADATA ? engine.duration : NaN,
  )
  define('paused', () => state.paused)
  define('ended', () => state.ended)
  define('seeking', () => state.seeking)
  define('readyState', () => state.readyState)
  define('networkState', () => state.networkState)
  define('buffered', () => timeRanges(engine.bufferedSeconds))
  define('error', () => state.error)
  define(
    'volume',
    () => state.volume,
    (v) => {
      state.volume = Math.min(1, Math.max(0, Number(v)))
      applyVolume()
      emit('volumechange')
    },
  )
  define(
    'muted',
    () => state.muted,
    (v) => {
      state.muted = !!v
      applyVolume()
      emit('volumechange')
    },
  )
  define('playbackRate', () => 1)
  // src is set on the element both ways: React renders it as an attribute, the library also assigns it.
  Object.defineProperty(el, 'src', {
    configurable: true,
    get: () => (isEngine() ? state.src : native.src.get.call(el)),
    set: (v) => {
      setSrc(v)
    },
  })
  const overrides = {
    play,
    pause,
    load,
    fastSeek: (t) => seek(Number(t)),
    setAttribute(name, value) {
      if (String(name).toLowerCase() === 'src') return setSrc(value)
      return nativeSetAttribute.call(el, name, value)
    },
    removeAttribute(name) {
      if (String(name).toLowerCase() === 'src') return setSrc('')
      return nativeRemoveAttribute.call(el, name)
    },
    getAttribute(name) {
      if (String(name).toLowerCase() === 'src' && isEngine()) return state.src
      return nativeGetAttribute.call(el, name)
    },
  }
  Object.entries(overrides).forEach(([name, fn]) => {
    Object.defineProperty(el, name, {
      configurable: true,
      writable: true,
      value: fn,
    })
  })

  applyVolume()
  // Take over whatever the library already gave the element before we were attached.
  const initial = nativeGetAttribute.call(el, 'src')
  if (initial) setSrc(initial)

  return () => {
    offEngine.forEach((off) => off())
    stopTimer()
    MEDIA_EVENTS.forEach((type) => el.removeEventListener(type, guard, true))
    const src = isEngine() ? state.src : null
    engine.stop()
    if (keeper) keeper.pause()
    for (const name of [...Object.keys(native), ...Object.keys(overrides)]) {
      delete el[name]
    }
    if (src) nativeSetAttribute.call(el, 'src', src)
  }
}
