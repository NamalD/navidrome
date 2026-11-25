import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { createStore, combineReducers } from 'redux'
import { describe, it, beforeEach } from 'vitest'

import ActivityPanel from './ActivityPanel'
import { activityReducer } from '../reducers'
import config from '../config'
import subsonic from '../subsonic'
import { httpClient } from '../dataProvider'

vi.mock('../subsonic', () => ({
  default: {
    getScanStatus: vi.fn(() =>
      Promise.resolve({
        json: {
          'subsonic-response': {
            status: 'ok',
            scanStatus: { error: 'Scan failed' },
          },
        },
      }),
    ),
    startScan: vi.fn(),
  },
}))

vi.mock('../dataProvider', () => ({
  httpClient: vi.fn(() => Promise.resolve({ json: [] })),
}))

describe('<ActivityPanel />', () => {
  let store

  beforeEach(() => {
    store = createStore(combineReducers({ activity: activityReducer }), {
      activity: {
        scanStatus: {
          scanning: false,
          folderCount: 0,
          count: 0,
          error: 'Scan failed',
          elapsedTime: 0,
        },
        serverStart: { version: config.version, startTime: Date.now() },
      },
    })
  })

  it('shows warning icon when server reports a scan error', () => {
    render(
      <Provider store={store}>
        <ActivityPanel />
      </Provider>,
    )

    // Warning icon should be visible when there's a scan error
    expect(screen.getByTestId('activity-warning-icon')).toBeInTheDocument()

    // Open the panel - warning icon should still be visible
    const button = screen.getByRole('button')
    fireEvent.click(button)
    expect(screen.getByTestId('activity-warning-icon')).toBeInTheDocument()
    expect(screen.getByText('Scan failed')).toBeInTheDocument()
  })

  it('shows how full the disk holding the library is', async () => {
    const GB = 1024 ** 3
    httpClient.mockResolvedValueOnce({
      json: [
        {
          id: 1,
          name: 'Music Library',
          total: 1000 * GB,
          used: 250 * GB,
          free: 750 * GB,
        },
      ],
    })
    render(
      <Provider store={store}>
        <ActivityPanel />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button'))

    const bar = await screen.findByRole('progressbar', {
      name: 'Music Library',
    })
    expect(bar).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByText('activity.storageUsage')).toBeInTheDocument()
    expect(httpClient).toHaveBeenCalledWith('/api/storage')
  })

  it('shows error icon when server is down', () => {
    const downStore = createStore(
      combineReducers({ activity: activityReducer }),
      {
        activity: {
          scanStatus: {
            scanning: false,
            folderCount: 0,
            count: 0,
            error: '',
            elapsedTime: 0,
          },
          serverStart: { version: config.version, startTime: null }, // null startTime = server down
        },
      },
    )

    render(
      <Provider store={downStore}>
        <ActivityPanel />
      </Provider>,
    )

    // Error icon should be visible when server is down
    expect(screen.getByTestId('activity-error-icon')).toBeInTheDocument()
  })
})
