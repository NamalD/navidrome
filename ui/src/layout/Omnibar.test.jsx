import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { createStore } from 'redux'
import { Router } from 'react-router-dom'
import { createMemoryHistory } from 'history'
import Omnibar from './Omnibar'
import config from '../config'
import { PLAYER_PLAY_TRACKS } from '../actions'

const { getList } = vi.hoisted(() => ({ getList: vi.fn() }))

vi.mock('react-admin', async () => {
  const { createContext } = await import('react')
  return {
    useTranslate: () => (key, options) =>
      options?.count ? `${key} ${options.count}` : key,
    DataProviderContext: createContext({ getList }),
  }
})
vi.mock('react-hotkeys', () => ({ GlobalHotKeys: () => null }))
vi.mock('../subsonic', () => ({
  default: { getCoverArtUrl: () => 'cover.jpg' },
}))
vi.mock('../common/useGetHandleArtistClick', () => ({
  useGetHandleArtistClick: () => (id) => `/artist/${id}/show`,
}))

const library = {
  artist: [{ id: 'ar1', name: 'Radiohead' }],
  album: [{ id: 'al1', name: 'OK Computer', albumArtist: 'Radiohead' }],
  song: [
    { id: 's1', title: 'Karma Police', artist: 'Radiohead', album: 'OK' },
    { id: 's2', title: 'Karma Chameleon', artist: 'Culture Club' },
  ],
  playlist: [],
}

describe('<Omnibar />', () => {
  let history
  let dispatch

  const type = async (text) => {
    const input = screen.getByRole('searchbox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: text } })
    return input
  }

  beforeEach(() => {
    config.uiSearchDebounceMs = 0
    getList.mockReset()
    getList.mockImplementation((resource) =>
      Promise.resolve({ data: library[resource], total: 9 }),
    )
    history = createMemoryHistory()
    const store = createStore((state = {}) => state)
    dispatch = vi.spyOn(store, 'dispatch')
    render(
      <Provider store={store}>
        <Router history={history}>
          <Omnibar />
        </Router>
      </Provider>,
    )
  })

  afterEach(cleanup)

  it('searches every resource with its own search filter', async () => {
    await type('karma')
    await screen.findByText('Karma Police')

    const filters = Object.fromEntries(
      getList.mock.calls.map(([resource, params]) => [resource, params.filter]),
    )
    expect(filters).toEqual({
      artist: { name: 'karma' },
      album: { name: 'karma' },
      song: { title: 'karma' },
      playlist: { q: 'karma' },
    })
  })

  it('searches without touching the Redux store', async () => {
    await type('karma')
    await screen.findByText('Karma Police')

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('groups the matches and leaves out groups without any', async () => {
    await type('radio')

    await screen.findByText('OK Computer')
    expect(screen.getAllByText('resources.artist.name')).toHaveLength(2)
    expect(screen.getByText('OK Computer')).toBeTruthy()
    expect(screen.getByText('Karma Chameleon')).toBeTruthy()
    expect(screen.queryByText('resources.playlist.name')).toBeNull()
  })

  it('opens the top result on Enter', async () => {
    const input = await type('radio')
    await screen.findByText('OK Computer')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(history.location.pathname).toBe('/artist/ar1/show')
    expect(input.value).toBe('')
  })

  it('moves through the groups with the arrow keys', async () => {
    const input = await type('radio')
    await screen.findByText('OK Computer')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(history.location.pathname).toBe('/album/al1/show')
  })

  it('plays a song when it is picked', async () => {
    await type('karma')
    fireEvent.click(await screen.findByText('Karma Police'))

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: PLAYER_PLAY_TRACKS, id: 's1' }),
    )
    expect(history.location.pathname).toBe('/')
  })

  it('links a group to its full list, filtered by the query', async () => {
    await type('karma')
    await screen.findByText('Karma Police')
    fireEvent.click(screen.getAllByText('omnibar.seeAll 9')[2])

    expect(history.location.pathname).toBe('/song')
    expect(history.location.search).toBe(
      `?filter=${encodeURIComponent('{"title":"karma"}')}`,
    )
  })

  it('says so when nothing matches', async () => {
    getList.mockImplementation(() => Promise.resolve({ data: [], total: 0 }))
    await type('zzz')

    expect(await screen.findByText('omnibar.noResults')).toBeTruthy()
  })

  it('closes on Escape', async () => {
    const input = await type('karma')
    await screen.findByText('Karma Police')
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByText('Karma Police')).toBeNull()
  })
})
