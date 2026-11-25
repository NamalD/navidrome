import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react-hooks'
import { waitFor } from '@testing-library/react'
import { useDispatch, useSelector } from 'react-redux'
import subsonic from '../subsonic'
import { PLAYER_ADD_TRACKS } from '../actions'
import {
  ENDLESS_PLAY_BATCH_SIZE,
  fetchContinuation,
  useEndlessPlay,
} from './useEndlessPlay'

vi.mock('../subsonic', () => ({
  default: { getSimilarSongs2: vi.fn(), getRandomSongs: vi.fn() },
}))

vi.mock('react-redux', () => ({
  useDispatch: vi.fn(),
  useSelector: vi.fn(),
}))

const songs = (prefix, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    title: `${prefix}${i + 1}`,
  }))

const similarResponse = (list) => ({
  json: {
    'subsonic-response': { status: 'ok', similarSongs2: { song: list } },
  },
})

const randomResponse = (list) => ({
  json: { 'subsonic-response': { status: 'ok', randomSongs: { song: list } } },
})

const failedResponse = () => ({
  json: {
    'subsonic-response': { status: 'failed', error: { code: 0, message: 'x' } },
  },
})

const ids = (list) => list.map((song) => song.id)

beforeEach(() => {
  vi.clearAllMocks()
  subsonic.getSimilarSongs2.mockResolvedValue(similarResponse([]))
  subsonic.getRandomSongs.mockResolvedValue(randomResponse([]))
})

describe('fetchContinuation', () => {
  it('returns similar songs that are not queued yet', async () => {
    subsonic.getSimilarSongs2.mockResolvedValue(similarResponse(songs('s', 5)))

    const result = await fetchContinuation('seed', ['seed', 's2'], 3)

    expect(subsonic.getSimilarSongs2).toHaveBeenCalledWith('seed', 100)
    expect(ids(result)).toEqual(['s1', 's3', 's4'])
    expect(subsonic.getRandomSongs).not.toHaveBeenCalled()
  })

  it('tops up with random songs when there are too few similar ones', async () => {
    subsonic.getSimilarSongs2.mockResolvedValue(similarResponse(songs('s', 1)))
    subsonic.getRandomSongs.mockResolvedValue(
      randomResponse([{ id: 's1' }, { id: 'seed' }, ...songs('r', 5)]),
    )

    const result = await fetchContinuation('seed', ['seed'], 3)

    expect(ids(result)).toEqual(['s1', 'r1', 'r2'])
  })

  it('uses random songs when similar songs cannot be fetched', async () => {
    subsonic.getSimilarSongs2.mockResolvedValue(failedResponse())
    subsonic.getRandomSongs.mockResolvedValue(randomResponse(songs('r', 5)))

    const result = await fetchContinuation('seed', ['seed'], 2)

    expect(ids(result)).toEqual(['r1', 'r2'])
  })

  it('repeats songs, except the seed, once everything is queued', async () => {
    subsonic.getRandomSongs.mockResolvedValue(
      randomResponse([{ id: 'seed' }, { id: 'a' }, { id: 'b' }]),
    )

    const result = await fetchContinuation('seed', ['seed', 'a', 'b'], 5)

    expect(ids(result)).toEqual(['a', 'b'])
  })

  it('rejects when random songs cannot be fetched', async () => {
    subsonic.getRandomSongs.mockResolvedValue(failedResponse())

    await expect(fetchContinuation('seed', ['seed'], 2)).rejects.toThrow()
  })
})

describe('useEndlessPlay', () => {
  const dispatch = vi.fn()
  let settings

  const track = (id) => ({ uuid: `uuid-${id}`, trackId: id })
  const playing = (queue, index, extra = {}) => ({
    queue,
    current: queue[index],
    ...extra,
  })

  beforeEach(() => {
    settings = { endlessPlay: true }
    useDispatch.mockReturnValue(dispatch)
    useSelector.mockImplementation((selector) => selector({ settings }))
    subsonic.getSimilarSongs2.mockResolvedValue(similarResponse(songs('s', 20)))
  })

  it('adds a batch of tracks when the last track of the queue is playing', async () => {
    const queue = [track('a'), track('b')]
    renderHook(() => useEndlessPlay(playing(queue, 1)))

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const action = dispatch.mock.calls[0][0]
    expect(action.type).toBe(PLAYER_ADD_TRACKS)
    expect(Object.keys(action.data)).toHaveLength(ENDLESS_PLAY_BATCH_SIZE)
    expect(subsonic.getSimilarSongs2).toHaveBeenCalledWith('b', 100)
  })

  it('does not fetch again when the queue changes for the same track', async () => {
    const queue = [track('a')]
    const { rerender } = renderHook((state) => useEndlessPlay(state), {
      initialProps: playing(queue, 0),
    })
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))

    rerender(playing([...queue], 0, { volume: 0.5 }))

    expect(subsonic.getSimilarSongs2).toHaveBeenCalledTimes(1)
  })

  it('extends the queue again when its new last track is reached', async () => {
    const queue = [track('a'), track('b')]
    const { rerender } = renderHook((state) => useEndlessPlay(state), {
      initialProps: playing(queue, 0),
    })
    expect(subsonic.getSimilarSongs2).not.toHaveBeenCalled()

    rerender(playing(queue, 1))

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  })

  it('drops the result when the track stops being the last one', async () => {
    let resolve
    subsonic.getSimilarSongs2.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const queue = [track('a')]
    const { rerender } = renderHook((state) => useEndlessPlay(state), {
      initialProps: playing(queue, 0),
    })

    rerender(playing([...queue, track('b')], 0))
    resolve(similarResponse(songs('s', 20)))
    await new Promise((r) => setTimeout(r, 0))

    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each([
    ['the setting is off', () => (settings.endlessPlay = false), {}],
    ['single loop mode is on', () => {}, { mode: 'singleLoop' }],
  ])('does nothing when %s', async (_, setup, extra) => {
    setup()
    renderHook(() => useEndlessPlay(playing([track('a')], 0, extra)))
    await new Promise((r) => setTimeout(r, 0))

    expect(subsonic.getSimilarSongs2).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does nothing for radio streams, earlier tracks or an idle player', async () => {
    const radio = { ...track('r'), isRadio: true }
    renderHook(() => useEndlessPlay(playing([radio], 0)))
    renderHook(() => useEndlessPlay(playing([track('a'), track('b')], 0)))
    renderHook(() => useEndlessPlay({ queue: [track('a')], current: {} }))
    await new Promise((r) => setTimeout(r, 0))

    expect(subsonic.getSimilarSongs2).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})
