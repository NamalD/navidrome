import { describe, expect, it, vi } from 'vitest'
import { nextQueueItem, songIdFromStreamUrl } from './index'

describe('songIdFromStreamUrl', () => {
  const here = window.location.origin

  it('finds the song in the player’s stream URLs', () => {
    expect(songIdFromStreamUrl('/rest/stream?id=abc&u=x')).toBe('abc')
    expect(songIdFromStreamUrl(`${here}/rest/stream.view?id=abc`)).toBe('abc')
    expect(
      songIdFromStreamUrl(
        '/rest/getTranscodeStream?mediaId=abc&mediaType=song&offset=0',
      ),
    ).toBe('abc')
  })

  it('ignores anything that is not a song on this server', () => {
    expect(
      songIdFromStreamUrl(
        '/rest/getTranscodeStream?mediaId=abc&mediaType=podcast',
      ),
    ).toBeNull()
    expect(
      songIdFromStreamUrl('https://radio.example/rest/stream?id=abc'),
    ).toBeNull()
    expect(songIdFromStreamUrl('/rest/getCoverArt?id=abc')).toBeNull()
    expect(songIdFromStreamUrl('http://[bad')).toBeNull()
  })
})

describe('nextQueueItem', () => {
  const queue = [{ uuid: 1 }, { uuid: 2 }, { uuid: 3 }]
  const at = (uuid, mode, q = queue) =>
    nextQueueItem({ queue: q, current: { uuid }, mode })

  it('follows the repeat mode', () => {
    expect(at(1, 'order')).toBe(queue[1])
    expect(at(3, 'order')).toBeNull()
    expect(at(3, 'orderLoop')).toBe(queue[0])
    expect(at(2, 'singleLoop')).toBe(queue[1])
    expect(at(1, 'shufflePlay')).toBeNull() // picked at random only at the end
  })

  it('has nothing to line up for radio or an unknown current item', () => {
    expect(at(1, 'order', [{ uuid: 1 }, { uuid: 2, isRadio: true }])).toBeNull()
    expect(at(9, 'order')).toBeNull()
  })
})

describe('canDecodeFlac', () => {
  it('decodes the probe with Web Audio when the browser can', async () => {
    vi.resetModules()
    const { FakeAudioContext } = await import('./testHelpers')
    const decoded = []
    vi.stubGlobal(
      'OfflineAudioContext',
      class extends FakeAudioContext {
        constructor(channels, length, rate) {
          super(rate)
        }
        async decodeAudioData(buffer) {
          const result = await super.decodeAudioData(buffer) // parses it as the engine's pieces are
          decoded.push(result.length)
          return result
        }
      },
    )
    try {
      const { canDecodeFlac } = await import('./index')
      expect(await canDecodeFlac()).toBe(true)
      expect(decoded).toEqual([88])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('says no when decoding fails or Web Audio is missing', async () => {
    for (const ctx of [
      class {
        decodeAudioData() {
          return Promise.reject(new DOMException('Decoding failed'))
        }
      },
      undefined,
    ]) {
      vi.resetModules()
      vi.stubGlobal('OfflineAudioContext', ctx)
      try {
        const { canDecodeFlac } = await import('./index')
        expect(await canDecodeFlac()).toBe(false)
      } finally {
        vi.unstubAllGlobals()
      }
    }
  })
})
