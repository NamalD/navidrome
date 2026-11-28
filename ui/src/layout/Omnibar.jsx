import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'
import { useHistory } from 'react-router-dom'
import { useTranslate } from 'react-admin'
import { GlobalHotKeys } from 'react-hotkeys'
import {
  Avatar,
  ClickAwayListener,
  InputBase,
  Link,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  ListSubheader,
  Paper,
  Popper,
  Typography,
  makeStyles,
  useMediaQuery,
  useTheme,
} from '@material-ui/core'
import { alpha } from '@material-ui/core/styles'
import SearchIcon from '@material-ui/icons/Search'
import subsonic from '../subsonic'
import { playTracks } from '../actions'
import { useGetHandleArtistClick } from '../common/useGetHandleArtistClick'
import { keyMap } from '../hotkeys'
import { useOmniSearch } from './useOmniSearch'
import { matchingLyricsLine } from './lyricsMatch'

const useStyles = makeStyles(
  (theme) => ({
    root: {
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      flex: '0 1 28em',
      minWidth: '8em',
      marginRight: theme.spacing(2),
      padding: theme.spacing(0, 1),
      borderRadius: theme.shape.borderRadius,
      backgroundColor: alpha(theme.palette.common.white, 0.15),
      '&:hover, &:focus-within': {
        backgroundColor: alpha(theme.palette.common.white, 0.25),
      },
    },
    icon: { marginRight: theme.spacing(1), opacity: 0.7 },
    input: { color: 'inherit', flex: 1 },
    popper: { zIndex: theme.zIndex.modal },
    paper: {
      marginTop: theme.spacing(0.5),
      maxHeight: '75vh',
      overflowY: 'auto',
    },
    subheader: {
      display: 'flex',
      justifyContent: 'space-between',
      backgroundColor: theme.palette.background.paper,
    },
    seeAll: { cursor: 'pointer' },
    round: { borderRadius: '50%' },
    empty: { padding: theme.spacing(2) },
  }),
  { name: 'NDOmnibar' },
)

const secondaryText = (section, record, translate, query) => {
  const { resource } = section
  if (section.key === 'lyrics') {
    // Lyrics from the tags, or else those fetched from a lyrics plugin
    const line =
      matchingLyricsLine(record.lyrics, query) ||
      matchingLyricsLine(record.fetchedLyrics, query)
    if (line) return `“${line}”`
  }
  switch (resource) {
    case 'album':
      return record.albumArtist
    case 'song':
      return [record.artist, record.album].filter(Boolean).join(' • ')
    case 'playlist':
      return record.ownerName
    default:
      return translate(`resources.${resource}.name`, { smart_count: 1 })
  }
}

// The current breakpoint name, as withWidth() would pass it
const useWidth = () => {
  const theme = useTheme()
  const keys = [...theme.breakpoints.keys].reverse()
  return (
    keys.reduce((output, key) => {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const matches = useMediaQuery(theme.breakpoints.up(key))
      return !output && matches ? key : output
    }, null) || 'xs'
  )
}

const Omnibar = () => {
  const classes = useStyles()
  const width = useWidth()
  const translate = useTranslate()
  const history = useHistory()
  const dispatch = useDispatch()
  const artistLink = useGetHandleArtistClick(width)
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const { sections, loading, query: answered } = useOmniSearch(query)

  // Flat list of the rows, so the arrow keys can walk across the groups
  const rows = useMemo(
    () =>
      sections.flatMap(({ resource, items }) =>
        items.map((record) => ({ resource, record })),
      ),
    [sections],
  )

  useEffect(() => setActive(0), [rows])

  const close = useCallback(() => {
    setOpen(false)
    inputRef.current?.blur()
  }, [])

  const select = useCallback(
    ({ resource, record }) => {
      if (resource === 'song') {
        dispatch(playTracks({ [record.id]: record }))
      } else if (resource === 'artist') {
        history.push(artistLink(record.id))
      } else {
        history.push(`/${resource}/${record.id}/show`)
      }
      setQuery('')
      close()
    },
    [dispatch, history, artistLink, close],
  )

  const seeAll = (section) => {
    const filter = encodeURIComponent(
      JSON.stringify({ [section.field]: answered }),
    )
    history.push(`/${section.resource}?filter=${filter}`)
    close()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length > 0) {
        const step = e.key === 'ArrowDown' ? 1 : -1
        setOpen(true)
        setActive((active + step + rows.length) % rows.length)
      }
    } else if (e.key === 'Enter' && open && rows[active]) {
      e.preventDefault()
      select(rows[active])
    }
  }

  const hotkeyHandlers = useMemo(
    () => ({
      FOCUS_SEARCH: (e) => {
        e?.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      },
    }),
    [],
  )

  const showResults = open && query.trim() !== ''
  let rowIndex = -1

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <div className={classes.root} ref={rootRef}>
        <GlobalHotKeys keyMap={keyMap} handlers={hotkeyHandlers} allowChanges />
        <SearchIcon className={classes.icon} fontSize="small" />
        <InputBase
          className={classes.input}
          inputRef={inputRef}
          value={query}
          placeholder={translate('omnibar.placeholder')}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          inputProps={{
            'aria-label': translate('omnibar.placeholder'),
            type: 'search',
            autoComplete: 'off',
          }}
        />
        <Popper
          open={showResults}
          anchorEl={rootRef.current}
          placement="bottom-start"
          className={classes.popper}
          style={{ width: Math.max(rootRef.current?.offsetWidth || 0, 320) }}
        >
          <Paper className={classes.paper} elevation={8}>
            {rows.length === 0 && (
              <Typography
                className={classes.empty}
                color="textSecondary"
                variant="body2"
              >
                {loading || answered !== query.trim()
                  ? translate('omnibar.searching')
                  : translate('omnibar.noResults')}
              </Typography>
            )}
            {sections.map((section) => (
              <List
                key={section.key}
                dense
                disablePadding
                subheader={
                  <ListSubheader className={classes.subheader}>
                    {section.key === 'lyrics'
                      ? translate('omnibar.lyrics')
                      : translate(`resources.${section.resource}.name`, {
                          smart_count: 2,
                        })}
                    {section.total > section.items.length && (
                      <Link
                        className={classes.seeAll}
                        onClick={() => seeAll(section)}
                      >
                        {translate('omnibar.seeAll', {
                          count: section.total,
                        })}
                      </Link>
                    )}
                  </ListSubheader>
                }
              >
                {section.items.map((record) => {
                  rowIndex += 1
                  const index = rowIndex
                  return (
                    <ListItem
                      button
                      key={record.id}
                      title={
                        section.key === 'lyrics'
                          ? [record.artist, record.album]
                              .filter(Boolean)
                              .join(' • ')
                          : undefined
                      }
                      selected={index === active}
                      onMouseEnter={() => setActive(index)}
                      onClick={() =>
                        select({ resource: section.resource, record })
                      }
                    >
                      <ListItemAvatar>
                        <Avatar
                          variant="rounded"
                          className={
                            section.resource === 'artist'
                              ? classes.round
                              : undefined
                          }
                          src={subsonic.getCoverArtUrl(record, 80, true)}
                          alt=""
                        />
                      </ListItemAvatar>
                      <ListItemText
                        primary={record.title || record.name}
                        secondary={secondaryText(
                          section,
                          record,
                          translate,
                          answered,
                        )}
                        primaryTypographyProps={{ noWrap: true }}
                        secondaryTypographyProps={{ noWrap: true }}
                      />
                    </ListItem>
                  )
                })}
              </List>
            ))}
          </Paper>
        </Popper>
      </div>
    </ClickAwayListener>
  )
}

export default Omnibar
