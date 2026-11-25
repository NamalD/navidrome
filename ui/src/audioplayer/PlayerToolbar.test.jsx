import React from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useMediaQuery } from '@material-ui/core'
import { useGetOne } from 'react-admin'
import { useDispatch, useSelector } from 'react-redux'
import { useToggleLove } from '../common'
import {
  openSaveQueueDialog,
  setEndlessPlay,
  setPlayMode,
  setShuffle,
} from '../actions'
import PlayerToolbar from './PlayerToolbar'

// Mock dependencies
vi.mock('@material-ui/core', async () => {
  const actual = await import('@material-ui/core')
  return {
    ...actual,
    useMediaQuery: vi.fn(),
  }
})

vi.mock('react-admin', () => ({
  useGetOne: vi.fn(),
  useTranslate: () => (key) => key,
}))

vi.mock('react-redux', () => ({
  useDispatch: vi.fn(),
  useSelector: vi.fn(),
}))

vi.mock('../common', () => ({
  LoveButton: ({ className, disabled }) => (
    <button data-testid="love-button" className={className} disabled={disabled}>
      Love
    </button>
  ),
  useToggleLove: vi.fn(),
}))

vi.mock('../actions', () => ({
  openSaveQueueDialog: vi.fn(),
  setEndlessPlay: vi.fn(),
  setPlayMode: vi.fn(),
  setShuffle: vi.fn(),
}))

vi.mock('react-hotkeys', () => ({
  GlobalHotKeys: () => <div data-testid="global-hotkeys" />,
}))

describe('<PlayerToolbar />', () => {
  const mockToggleLove = vi.fn()
  const mockDispatch = vi.fn()
  const mockSongData = { id: 'song-1', name: 'Test Song', starred: false }
  let settings
  let player

  beforeEach(() => {
    vi.clearAllMocks()
    useGetOne.mockReturnValue({ data: mockSongData, loading: false })
    useToggleLove.mockReturnValue([mockToggleLove, false])
    useDispatch.mockReturnValue(mockDispatch)
    openSaveQueueDialog.mockReturnValue({ type: 'OPEN_SAVE_QUEUE_DIALOG' })
    setEndlessPlay.mockImplementation((enabled) => ({
      type: 'SET_ENDLESS_PLAY',
      data: enabled,
    }))
    setPlayMode.mockImplementation((mode) => ({
      type: 'PLAYER_SET_MODE',
      data: { mode },
    }))
    setShuffle.mockImplementation((shuffle) => ({
      type: 'PLAYER_SET_SHUFFLE',
      data: { shuffle },
    }))
    settings = { endlessPlay: false }
    player = {}
    useSelector.mockImplementation((selector) => selector({ settings, player }))
  })

  afterEach(cleanup)

  describe('Desktop layout', () => {
    beforeEach(() => {
      useMediaQuery.mockReturnValue(true) // isDesktop = true
    })

    it('renders desktop toolbar with all buttons', () => {
      render(<PlayerToolbar id="song-1" />)

      // All buttons should be in a single list item
      const listItems = screen.getAllByRole('listitem')
      expect(listItems).toHaveLength(1)

      // Verify all buttons are rendered
      expect(screen.getByTestId('shuffle-button')).toBeInTheDocument()
      expect(screen.getByTestId('repeat-button')).toBeInTheDocument()
      expect(screen.getByTestId('endless-play-button')).toBeInTheDocument()
      expect(screen.getByTestId('save-queue-button')).toBeInTheDocument()
      expect(screen.getByTestId('love-button')).toBeInTheDocument()
      expect(screen.getByTestId('toggle-lyrics-button')).toBeInTheDocument()

      // Verify desktop classes are applied
      expect(listItems[0].className).toContain('toolbar')
    })

    it('turns endless play on when the button is clicked', () => {
      render(<PlayerToolbar id="song-1" />)

      const button = screen.getByTestId('endless-play-button')
      expect(button).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(button)

      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'SET_ENDLESS_PLAY',
        data: true,
      })
    })

    it('turns endless play off when it is already on', () => {
      settings.endlessPlay = true
      render(<PlayerToolbar id="song-1" />)

      const button = screen.getByTestId('endless-play-button')
      expect(button).toHaveAttribute('aria-pressed', 'true')
      fireEvent.click(button)

      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'SET_ENDLESS_PLAY',
        data: false,
      })
    })

    it.each([
      [false, true],
      [true, false],
    ])('toggles shuffle from %s to %s', (current, next) => {
      player.shuffle = current
      render(<PlayerToolbar id="song-1" />)

      const button = screen.getByTestId('shuffle-button')
      expect(button).toHaveAttribute('aria-pressed', String(current))
      fireEvent.click(button)

      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'PLAYER_SET_SHUFFLE',
        data: { shuffle: next },
      })
    })

    it.each([
      [undefined, 'orderLoop'],
      ['order', 'orderLoop'],
      ['orderLoop', 'singleLoop'],
      ['singleLoop', 'order'],
    ])('cycles repeat from %s to %s', (current, next) => {
      player.mode = current
      render(<PlayerToolbar id="song-1" />)

      const button = screen.getByTestId('repeat-button')
      expect(button).toHaveAttribute('data-mode', current || 'order')
      fireEvent.click(button)

      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'PLAYER_SET_MODE',
        data: { mode: next },
      })
    })

    it('leaves repeat alone when shuffle is toggled', () => {
      player.mode = 'singleLoop'
      render(<PlayerToolbar id="song-1" />)

      fireEvent.click(screen.getByTestId('shuffle-button'))

      expect(mockDispatch).toHaveBeenCalledTimes(1)
      expect(setPlayMode).not.toHaveBeenCalled()
    })

    it('disables shuffle and repeat buttons when isRadio is true', () => {
      render(<PlayerToolbar id="song-1" isRadio={true} />)

      expect(screen.getByTestId('shuffle-button')).toBeDisabled()
      expect(screen.getByTestId('repeat-button')).toBeDisabled()
    })

    it('disables endless play button when isRadio is true', () => {
      render(<PlayerToolbar id="song-1" isRadio={true} />)

      expect(screen.getByTestId('endless-play-button')).toBeDisabled()
    })

    it('opens save queue dialog when save button is clicked', () => {
      render(<PlayerToolbar id="song-1" />)

      const saveQueueButton = screen.getByTestId('save-queue-button')
      fireEvent.click(saveQueueButton)

      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'OPEN_SAVE_QUEUE_DIALOG',
      })
    })

    it('toggles lyrics from an accessible toolbar button', () => {
      const onToggleLyrics = vi.fn()
      const lyricsToggleRef = React.createRef()
      render(
        <PlayerToolbar
          id="song-1"
          onToggleLyrics={onToggleLyrics}
          lyricsActive
          lyricsToggleRef={lyricsToggleRef}
        />,
      )

      const lyricsButton = screen.getByLabelText('Toggle lyrics')
      expect(lyricsButton).toHaveAttribute(
        'data-testid',
        'toggle-lyrics-button',
      )
      expect(lyricsButton).toHaveClass('MuiIconButton-colorPrimary')
      expect(lyricsButton).toHaveAttribute('aria-pressed', 'true')
      expect(lyricsToggleRef.current).toBe(lyricsButton)

      fireEvent.click(lyricsButton)

      expect(onToggleLyrics).toHaveBeenCalledTimes(1)
    })
  })

  describe('Mobile layout', () => {
    beforeEach(() => {
      useMediaQuery.mockReturnValue(false) // isDesktop = false
    })

    it('renders mobile toolbar with buttons in separate list items', () => {
      render(<PlayerToolbar id="song-1" />)

      // Each button should be in its own list item
      const listItems = screen.getAllByRole('listitem')
      expect(listItems).toHaveLength(6)

      // Verify all buttons are rendered
      expect(screen.getByTestId('shuffle-button')).toBeInTheDocument()
      expect(screen.getByTestId('repeat-button')).toBeInTheDocument()
      expect(screen.getByTestId('endless-play-button')).toBeInTheDocument()
      expect(screen.getByTestId('save-queue-button')).toBeInTheDocument()
      expect(screen.getByTestId('love-button')).toBeInTheDocument()
      expect(screen.getByTestId('toggle-lyrics-button')).toBeInTheDocument()

      // Verify mobile classes are applied
      expect(listItems[0].className).toContain('mobileListItem')
      expect(listItems[1].className).toContain('mobileListItem')
      expect(listItems[2].className).toContain('mobileListItem')
      expect(listItems[3].className).toContain('mobileListItem')
    })

    it('disables lyrics toggle when lyrics are unavailable', () => {
      render(
        <PlayerToolbar id="song-1" onToggleLyrics={vi.fn()} lyricsDisabled />,
      )

      expect(screen.getByTestId('toggle-lyrics-button')).toBeDisabled()
    })

    it('shows loading state on the lyrics toggle before lyrics are available', () => {
      render(
        <PlayerToolbar id="song-1" onToggleLyrics={vi.fn()} lyricsLoading />,
      )

      const lyricsButton = screen.getByTestId('toggle-lyrics-button')
      expect(lyricsButton).toBeDisabled()
      expect(lyricsButton).toHaveAttribute('aria-label', 'Loading lyrics')
      expect(lyricsButton).toHaveAttribute('aria-busy', 'true')
      expect(lyricsButton).toHaveAttribute('aria-pressed', 'false')
    })
  })

  describe('Common behavior', () => {
    it('disables save queue button when isRadio is true', () => {
      useMediaQuery.mockReturnValue(true)
      render(<PlayerToolbar id="song-1" isRadio={true} />)

      expect(screen.getByTestId('save-queue-button')).toBeDisabled()
    })

    it('disables love button when conditions are met', () => {
      useMediaQuery.mockReturnValue(true)
      useGetOne.mockReturnValue({ data: mockSongData, loading: true })

      render(<PlayerToolbar id="song-1" />)

      expect(screen.getByTestId('love-button')).toBeDisabled()
    })

    it('renders global hotkeys in both layouts', () => {
      // Test desktop layout
      useMediaQuery.mockReturnValue(true)
      render(<PlayerToolbar id="song-1" />)
      expect(screen.getByTestId('global-hotkeys')).toBeInTheDocument()

      // Cleanup and test mobile layout
      cleanup()
      useMediaQuery.mockReturnValue(false)
      render(<PlayerToolbar id="song-1" />)
      expect(screen.getByTestId('global-hotkeys')).toBeInTheDocument()
    })

    it('disables buttons when id is not provided', () => {
      render(<PlayerToolbar />)

      const loveButton = screen.getByTestId('love-button')
      expect(loveButton).toBeDisabled()
    })
  })
})
