import React, { useCallback } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useGetOne, useTranslate } from 'react-admin'
import { GlobalHotKeys } from 'react-hotkeys'
import IconButton from '@material-ui/core/IconButton'
import { useMediaQuery } from '@material-ui/core'
import Tooltip from '@material-ui/core/Tooltip'
import {
  RiFileMusicLine,
  RiInfinityLine,
  RiRepeat2Line,
  RiRepeatOneLine,
  RiSaveLine,
  RiShuffleLine,
} from 'react-icons/ri'
import { LoveButton, useToggleLove } from '../common'
import {
  openSaveQueueDialog,
  setEndlessPlay,
  setPlayMode,
  setShuffle,
} from '../actions'
import { keyMap } from '../hotkeys'
import { makeStyles } from '@material-ui/core/styles'
import { PLAYER_DESKTOP_MEDIA_QUERY } from './playerBreakpoints'

// Repeat cycles like Spotify's button: off, repeat the queue, repeat the track
const REPEAT_MODES = ['order', 'orderLoop', 'singleLoop']

const useStyles = makeStyles((theme) => ({
  // Shuffle and repeat sit on either side of the previous/play/next buttons
  shuffle: {
    order: -1,
    display: 'inline-flex',
  },
  repeat: {
    display: 'inline-flex',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    flexGrow: 1,
    justifyContent: 'flex-end',
    gap: '0.5rem',
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  mobileListItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    listStyle: 'none',
    padding: theme.spacing(0.5),
    margin: 0,
    height: 24,
  },
  button: {
    width: '2.5rem',
    height: '2.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  mobileButton: {
    width: 24,
    height: 24,
    padding: 0,
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '18px',
  },
  mobileIcon: {
    fontSize: '18px',
    display: 'flex',
    alignItems: 'center',
  },
}))

const PlayerToolbar = ({
  id,
  isRadio,
  onToggleLyrics,
  lyricsActive = false,
  lyricsDisabled = false,
  lyricsLoading = false,
  lyricsLabel = 'Toggle lyrics',
  lyricsLoadingLabel = 'Loading lyrics',
  lyricsToggleRef,
}) => {
  const dispatch = useDispatch()
  const translate = useTranslate()
  const endlessPlay = useSelector(
    (state) => state.settings.endlessPlay || false,
  )
  const shuffle = useSelector((state) => state.player.shuffle || false)
  const playMode = useSelector((state) => state.player.mode)
  const repeatMode = REPEAT_MODES.includes(playMode) ? playMode : 'order'
  const { data, loading } = useGetOne('song', id, { enabled: !!id && !isRadio })
  const [toggleLove, toggling] = useToggleLove('song', data)
  const isDesktop = useMediaQuery(PLAYER_DESKTOP_MEDIA_QUERY)
  const classes = useStyles()

  const handlers = {
    TOGGLE_LOVE: useCallback(() => toggleLove(), [toggleLove]),
  }

  const handleSaveQueue = useCallback(
    (e) => {
      dispatch(openSaveQueueDialog())
      e.stopPropagation()
    },
    [dispatch],
  )

  const handleToggleEndlessPlay = useCallback(
    (e) => {
      dispatch(setEndlessPlay(!endlessPlay))
      e.stopPropagation()
    },
    [dispatch, endlessPlay],
  )

  const handleToggleShuffle = useCallback(
    (e) => {
      dispatch(setShuffle(!shuffle))
      e.stopPropagation()
    },
    [dispatch, shuffle],
  )

  const handleCycleRepeat = useCallback(
    (e) => {
      const next = REPEAT_MODES.indexOf(repeatMode) + 1
      dispatch(setPlayMode(REPEAT_MODES[next % REPEAT_MODES.length]))
      e.stopPropagation()
    },
    [dispatch, repeatMode],
  )

  const buttonClass = isDesktop ? classes.button : classes.mobileButton
  const listItemClass = isDesktop ? classes.toolbar : classes.mobileListItem
  const lyricsUnavailable = lyricsDisabled || (lyricsLoading && !lyricsActive)

  const saveQueueButton = (
    <IconButton
      size={isDesktop ? 'small' : undefined}
      onClick={handleSaveQueue}
      disabled={isRadio}
      data-testid="save-queue-button"
      className={buttonClass}
    >
      <RiSaveLine className={!isDesktop ? classes.mobileIcon : undefined} />
    </IconButton>
  )

  const endlessPlayLabel = translate('player.endlessPlayText')
  const endlessPlayButton = (
    <IconButton
      size={isDesktop ? 'small' : undefined}
      onClick={handleToggleEndlessPlay}
      disabled={isRadio}
      color={endlessPlay ? 'primary' : 'default'}
      title={endlessPlayLabel}
      aria-label={endlessPlayLabel}
      aria-pressed={endlessPlay}
      data-testid="endless-play-button"
      className={buttonClass}
    >
      <RiInfinityLine className={!isDesktop ? classes.mobileIcon : undefined} />
    </IconButton>
  )

  const shuffleLabel = translate('player.playModeText.shufflePlay')
  const shuffleButton = (
    <IconButton
      size={isDesktop ? 'small' : undefined}
      onClick={handleToggleShuffle}
      disabled={isRadio}
      color={shuffle ? 'primary' : 'default'}
      title={shuffleLabel}
      aria-label={shuffleLabel}
      aria-pressed={shuffle}
      data-testid="shuffle-button"
      className={buttonClass}
    >
      <RiShuffleLine className={!isDesktop ? classes.mobileIcon : undefined} />
    </IconButton>
  )

  const repeatLabel = translate(`player.playModeText.${repeatMode}`)
  const RepeatIcon =
    repeatMode === 'singleLoop' ? RiRepeatOneLine : RiRepeat2Line
  const repeatButton = (
    <IconButton
      size={isDesktop ? 'small' : undefined}
      onClick={handleCycleRepeat}
      disabled={isRadio}
      color={repeatMode === 'order' ? 'default' : 'primary'}
      title={repeatLabel}
      aria-label={repeatLabel}
      data-testid="repeat-button"
      data-mode={repeatMode}
      className={buttonClass}
    >
      <RepeatIcon className={!isDesktop ? classes.mobileIcon : undefined} />
    </IconButton>
  )

  const loveButton = (
    <LoveButton
      record={data}
      resource={'song'}
      size={isDesktop ? undefined : 'inherit'}
      disabled={loading || toggling || !id || isRadio}
      className={buttonClass}
    />
  )

  const currentLyricsLabel = lyricsLoading ? lyricsLoadingLabel : lyricsLabel
  const lyricsButton = (
    <Tooltip title={currentLyricsLabel}>
      <span>
        <IconButton
          ref={lyricsToggleRef}
          size={isDesktop ? 'small' : undefined}
          onClick={onToggleLyrics}
          disabled={!onToggleLyrics || lyricsUnavailable}
          data-testid="toggle-lyrics-button"
          className={buttonClass}
          color={lyricsActive ? 'primary' : 'default'}
          aria-label={currentLyricsLabel}
          aria-busy={lyricsLoading}
          aria-pressed={lyricsActive}
        >
          <RiFileMusicLine
            aria-hidden="true"
            className={!isDesktop ? classes.mobileIcon : undefined}
          />
        </IconButton>
      </span>
    </Tooltip>
  )

  return (
    <>
      <GlobalHotKeys keyMap={keyMap} handlers={handlers} allowChanges />
      {isDesktop ? (
        <>
          <span className={classes.shuffle}>{shuffleButton}</span>
          <span className={classes.repeat}>{repeatButton}</span>
          <li className={`${listItemClass} item`}>
            {endlessPlayButton}
            {saveQueueButton}
            {loveButton}
            {lyricsButton}
          </li>
        </>
      ) : (
        <>
          <li className={`${listItemClass} item`}>{shuffleButton}</li>
          <li className={`${listItemClass} item`}>{repeatButton}</li>
          <li className={`${listItemClass} item`}>{endlessPlayButton}</li>
          <li className={`${listItemClass} item`}>{saveQueueButton}</li>
          <li className={`${listItemClass} item`}>{loveButton}</li>
          <li className={`${listItemClass} item`}>{lyricsButton}</li>
        </>
      )}
    </>
  )
}

export default PlayerToolbar
