import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachGaplessFacade } from './mediaFacade'
import { flush } from './testHelpers'

// Stands in for GaplessEngine: records calls and lets the test fire its events.
const fakeEngine = () => {
  const listeners = {}
  return {
    calls: [],
    currentTime: 0,
    duration: 120,
    bufferedSeconds: 0,
    continuation: null,
    on(type, fn) {
      listeners[type] = fn
      return () => delete listeners[type]
    },
    fire(type, detail) {
      listeners[type]?.(detail)
    },
    load(track) {
      this.calls.push(['load', track.key])
    },
    play: vi.fn(() => Promise.resolve()),
    pause() {
      this.calls.push(['pause'])
    },
    seek(t) {
      this.calls.push(['seek', t])
      return Promise.resolve()
    },
    stop() {
      this.calls.push(['stop'])
    },
    setVolume(v) {
      this.volume = v
    },
    acceptContinuation(key) {
      return this.continuation === key
    },
  }
}

const SONG = '/rest/stream?id=song1'
const RADIO = 'https://radio.example/stream.mp3'
const resolveTrack = (src) =>
  src.includes('id=') ? { key: src.split('id=')[1] } : null

describe('attachGaplessFacade', () => {
  let el, engine, keeper, seen, detach

  beforeEach(() => {
    // jsdom has no media playback; the element's own methods must still be callable
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() =>
      Promise.resolve(),
    )
    el = document.createElement('audio')
    document.body.appendChild(el)
    engine = fakeEngine()
    keeper = { play: vi.fn(), pause: vi.fn() }
    const log = [] // each test's own, so events queued by an earlier test land elsewhere
    seen = log
    for (const type of [
      'loadstart',
      'durationchange',
      'loadedmetadata',
      'loadeddata',
      'canplay',
      'canplaythrough',
      'play',
      'playing',
      'pause',
      'timeupdate',
      'seeking',
      'seeked',
      'ended',
      'error',
      'volumechange',
    ]) {
      el.addEventListener(type, () => log.push(type))
    }
    detach = attachGaplessFacade(el, engine, { resolveTrack, keeper })
  })

  afterEach(() => {
    detach()
    el.remove()
    vi.restoreAllMocks()
  })

  it('loads a song in the engine when src is set, once even if load() follows', async () => {
    el.src = SONG
    el.load()
    expect(engine.calls).toEqual([['load', 'song1']])
    expect(el.src).toBe(SONG)
    expect(el.getAttribute('src')).toBe(SONG)
    expect(el.readyState).toBe(0)
    expect(el.duration).toBeNaN()
    await flush()
    engine.fire('metadata')
    engine.fire('ready')
    expect(seen).toEqual([
      'loadstart',
      'durationchange',
      'loadedmetadata',
      'loadeddata',
      'canplay',
      'canplaythrough',
    ])
    expect(el.readyState).toBe(4)
    expect(el.duration).toBe(120)
  })

  it('stops the element’s own media events, but not its other events', () => {
    el.src = SONG
    el.dispatchEvent(new Event('pause'))
    el.dispatchEvent(new Event('error'))
    expect(seen).toEqual([])
    const click = vi.fn()
    el.addEventListener('click', click)
    el.dispatchEvent(new Event('click'))
    expect(click).toHaveBeenCalled()
  })

  it('plays and pauses like an element', async () => {
    el.src = SONG
    await flush()
    seen.length = 0
    await el.play()
    await flush()
    expect(el.paused).toBe(false)
    expect(seen).toEqual(['play', 'playing'])
    expect(keeper.play).toHaveBeenCalled()
    seen.length = 0
    el.pause()
    await flush()
    expect(el.paused).toBe(true)
    expect(engine.calls.at(-1)).toEqual(['pause'])
    expect(seen).toEqual(['timeupdate', 'pause'])
    expect(keeper.pause).toHaveBeenCalled()
  })

  it('passes on a refused play() and goes back to paused', async () => {
    el.src = SONG
    const refused = Object.assign(new Error('no'), { name: 'NotAllowedError' })
    engine.play.mockImplementationOnce(() => Promise.reject(refused))
    await expect(el.play()).rejects.toBe(refused)
    expect(el.paused).toBe(true)
    expect(seen).toContain('pause')
  })

  it('seeks through the engine when currentTime is set', async () => {
    el.src = SONG
    await flush()
    seen.length = 0
    el.currentTime = 42
    expect(engine.calls.at(-1)).toEqual(['seek', 42])
    expect(el.seeking).toBe(true)
    await flush()
    expect(el.seeking).toBe(false)
    expect(seen).toEqual(['seeking', 'timeupdate', 'seeked'])
  })

  it('carries on into the next song when the engine already started it', async () => {
    el.src = SONG
    await el.play()
    await flush()
    seen.length = 0
    engine.continuation = 'song2'
    engine.fire('ended', { key: 'song1', continued: true })
    expect(seen).toEqual(['timeupdate', 'pause', 'ended'])
    expect(el.ended).toBe(true)
    expect(keeper.pause).not.toHaveBeenCalled() // the media session stays active
    // the library then moves to the next song and plays it
    el.src = '/rest/stream?id=song2'
    await el.play()
    await flush()
    expect(engine.calls.filter(([c]) => c === 'load')).toEqual([
      ['load', 'song1'],
    ])
    expect(el.readyState).toBe(4)
    expect(el.paused).toBe(false)
    expect(seen).toContain('canplaythrough')
  })

  it('keeps going when repeating one song: no rewind, no reload', async () => {
    el.src = SONG
    await el.play()
    await flush()
    engine.continuation = 'song1'
    engine.fire('ended', { key: 'song1', continued: true })
    // what the library does for repeat-one
    el.currentTime = 0
    await el.play()
    await flush()
    expect(engine.calls.filter(([c]) => c !== 'load')).toEqual([])
    expect(el.paused).toBe(false)
    expect(el.ended).toBe(false)
    // later rewinds are real ones
    el.currentTime = 0
    expect(engine.calls.at(-1)).toEqual(['seek', 0])
  })

  it('restarts an ended song that the engine did not carry on with', async () => {
    el.src = SONG
    await el.play()
    engine.fire('ended', { key: 'song1', continued: false })
    await el.play()
    expect(engine.calls.at(-1)).toEqual(['seek', 0])
  })

  it('reports an engine error as a media error', () => {
    el.src = SONG
    engine.fire('error', new Error('HTTP 500'))
    expect(el.error).toMatchObject({ code: 2, message: 'HTTP 500' })
    expect(seen).toEqual(['error'])
  })

  it('applies volume and mute to the engine', () => {
    el.src = SONG
    el.volume = 0.5
    expect(engine.volume).toBe(0.5)
    el.muted = true
    expect(engine.volume).toBe(0)
    expect(el.volume).toBe(0.5)
  })

  it('leaves internet radio to the element', () => {
    el.src = SONG
    el.src = RADIO
    expect(engine.calls.at(-1)).toEqual(['stop'])
    expect(HTMLMediaElement.prototype.getAttribute.call(el, 'src')).toBe(RADIO)
    el.play()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
    el.dispatchEvent(new Event('pause')) // the element's own events reach the player again
    expect(seen).toEqual(['pause'])
  })

  it('gives the element back on detach', () => {
    el.src = SONG
    detach()
    expect(Object.getOwnPropertyNames(el)).not.toContain('src')
    expect(el.getAttribute('src')).toBe(SONG)
    detach = () => {}
  })
})
