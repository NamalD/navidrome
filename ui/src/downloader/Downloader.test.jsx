import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, beforeEach, expect, vi } from 'vitest'

import Downloader from './Downloader'
import { httpClient } from '../dataProvider'

const mockNotify = vi.fn()

vi.mock('react-admin', () => ({
  Title: () => null,
  useNotify: () => mockNotify,
  useTranslate: () => (key, options) =>
    options ? `${key} ${JSON.stringify(options)}` : key,
}))

vi.mock('../dataProvider', () => ({ httpClient: vi.fn() }))

const album = {
  title: 'Getting Killed',
  artist: 'Geese',
  year: 2025,
  artworkUrl: 'https://img.example/1.jpg',
  url: 'https://open.spotify.com/album/1',
}

const runningJob = {
  id: 'j1',
  url: album.url,
  title: 'Getting Killed',
  artist: 'Geese',
  status: 'running',
  tracksTotal: 11,
  tracksDone: 4,
  tracksFailed: 0,
  tracksSkipped: 0,
  currentTrack: 'Islands of Men',
}

// Answers the page's requests: the list of jobs, a search, and starting a download
const serve = ({ jobs = [], results = [album], started = runningJob } = {}) =>
  httpClient.mockImplementation((url, options) => {
    if (options?.method === 'POST') {
      return Promise.resolve({ json: started })
    }
    if (url.includes('/downloader/search')) {
      return Promise.resolve({ json: results })
    }
    return Promise.resolve({ json: jobs })
  })

const search = (text) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
  fireEvent.submit(screen.getByRole('textbox').closest('form'))
}

describe('<Downloader />', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('finds albums and downloads the one that is picked', async () => {
    serve()
    render(<Downloader />)

    search('getting killed')
    expect(await screen.findByText('Getting Killed')).toBeInTheDocument()
    expect(screen.getByText('Geese · 2025')).toBeInTheDocument()
    expect(httpClient).toHaveBeenCalledWith(
      '/api/downloader/search?q=getting%20killed',
    )

    fireEvent.click(screen.getByRole('button', { name: 'ra.action.download' }))
    await waitFor(() =>
      expect(httpClient).toHaveBeenCalledWith('/api/downloader/job', {
        method: 'POST',
        body: JSON.stringify(album),
      }),
    )
    // The album is now in the list of downloads and can't be asked for twice
    expect(
      await screen.findByRole('button', { name: 'downloader.downloading' }),
    ).toBeDisabled()
    expect(screen.getByText('Getting Killed · Geese')).toBeInTheDocument()
  })

  it('downloads a pasted link without searching', async () => {
    serve()
    render(<Downloader />)

    search(' https://open.spotify.com/album/1 ')
    await waitFor(() =>
      expect(httpClient).toHaveBeenCalledWith('/api/downloader/job', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://open.spotify.com/album/1' }),
      }),
    )
    expect(httpClient).not.toHaveBeenCalledWith(
      expect.stringContaining('/downloader/search'),
    )
  })

  it('shows how far each download is', async () => {
    serve({
      jobs: [
        runningJob,
        { ...runningJob, id: 'j2', status: 'queued', title: 'Queued album' },
        {
          ...runningJob,
          id: 'j3',
          status: 'failed',
          title: 'Broken album',
          error: 'no source',
        },
      ],
    })
    render(<Downloader />)

    expect(
      await screen.findByText(
        'downloader.status.running {"done":4,"total":11,"track":"Islands of Men"}',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('downloader.status.queued')).toBeInTheDocument()
    expect(
      screen.getByText('downloader.status.failed {"error":"no source"}'),
    ).toBeInTheDocument()
    // Only downloads that are still going have a progress bar
    expect(screen.getAllByRole('progressbar')).toHaveLength(2)
  })

  it('says so when nothing is found', async () => {
    serve({ results: [] })
    render(<Downloader />)

    search('zzzz')
    expect(await screen.findByText('downloader.noResults')).toBeInTheDocument()
  })

  it('warns when the download service fails', async () => {
    httpClient.mockImplementation((url) =>
      url.includes('/downloader/search')
        ? Promise.reject(new Error('Bad Gateway'))
        : Promise.resolve({ json: [] }),
    )
    render(<Downloader />)

    search('geese')
    await waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith('downloader.error', 'warning'),
    )
  })
})
