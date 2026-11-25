import React, { useCallback, useEffect, useState } from 'react'
import { Title, useNotify, useTranslate } from 'react-admin'
import {
  Avatar,
  Button,
  Card,
  CardContent,
  CircularProgress,
  LinearProgress,
  List,
  ListItem,
  ListItemAvatar,
  ListItemSecondaryAction,
  ListItemText,
  TextField,
  Typography,
} from '@material-ui/core'
import { makeStyles } from '@material-ui/core/styles'
import AlbumIcon from '@material-ui/icons/Album'
import { useInterval } from '../common'
import { httpClient } from '../dataProvider'
import { REST_URL } from '../consts'

const POLL_INTERVAL = 3000

const useStyles = makeStyles((theme) => ({
  root: { marginTop: '1em' },
  searchForm: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(2),
  },
  searchInput: { flex: 1 },
  section: { marginTop: theme.spacing(3) },
  cover: { width: 56, height: 56, marginRight: theme.spacing(2) },
  // Leaves room for the button, which is wider than the icon a secondary action usually holds
  item: { paddingRight: theme.spacing(18) },
  progress: { marginTop: theme.spacing(0.5) },
}))

const isActive = (job) => job.status === 'queued' || job.status === 'running'

const isLink = (text) => /^https:\/\/\S+$/.test(text)

const Cover = ({ src, className }) => (
  <ListItemAvatar>
    <Avatar variant="rounded" src={src || undefined} className={className}>
      <AlbumIcon />
    </Avatar>
  </ListItemAvatar>
)

const jobStatus = (job, translate) => {
  switch (job.status) {
    case 'queued':
      return translate('downloader.status.queued')
    case 'running':
      return job.tracksTotal > 0
        ? translate('downloader.status.running', {
            done: job.tracksDone + job.tracksFailed + job.tracksSkipped,
            total: job.tracksTotal,
            track: job.currentTrack,
          })
        : translate('downloader.status.starting')
    case 'completed':
      if (job.tracksDone === 0) {
        return translate('downloader.status.alreadyInLibrary')
      }
      return job.tracksFailed > 0
        ? translate('downloader.status.completedWithFailures', {
            smart_count: job.tracksDone,
            failed: job.tracksFailed,
          })
        : translate('downloader.status.completed', {
            smart_count: job.tracksDone,
          })
    default:
      return translate('downloader.status.failed', { error: job.error })
  }
}

const JobProgress = ({ job, className }) => {
  if (!isActive(job)) {
    return null
  }
  const known = job.status === 'running' && job.tracksTotal > 0
  const finished = job.tracksDone + job.tracksFailed + job.tracksSkipped
  return (
    <LinearProgress
      className={className}
      variant={known ? 'determinate' : 'indeterminate'}
      value={known ? (finished / job.tracksTotal) * 100 : undefined}
    />
  )
}

const Downloader = () => {
  const classes = useStyles()
  const translate = useTranslate()
  const notify = useNotify()
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  // null until a search has been made
  const [results, setResults] = useState(null)
  const [jobs, setJobs] = useState([])

  const loadJobs = useCallback(() => {
    httpClient(`${REST_URL}/downloader/job`)
      .then(({ json }) => setJobs(json))
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadJobs()
  }, [loadJobs])
  useInterval(loadJobs, jobs.some(isActive) ? POLL_INTERVAL : null)

  const download = (item) => {
    httpClient(`${REST_URL}/downloader/job`, {
      method: 'POST',
      body: JSON.stringify(item),
    })
      .then(({ json }) => {
        setJobs((prev) => [json, ...prev.filter((job) => job.id !== json.id)])
      })
      .catch(() => notify('downloader.error', 'warning'))
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    const text = query.trim()
    if (!text) {
      return
    }
    if (isLink(text)) {
      download({ url: text })
      setQuery('')
      return
    }
    setSearching(true)
    httpClient(`${REST_URL}/downloader/search?q=${encodeURIComponent(text)}`)
      .then(({ json }) => setResults(json))
      .catch(() => notify('downloader.error', 'warning'))
      .finally(() => setSearching(false))
  }

  const jobFor = (url) => jobs.find((job) => job.url === url)

  const downloadLabel = (job) => {
    if (!job || job.status === 'failed') {
      return translate('ra.action.download')
    }
    return translate(
      isActive(job) ? 'downloader.downloading' : 'downloader.downloaded',
    )
  }

  return (
    <Card className={classes.root}>
      <Title title={'Navidrome - ' + translate('menu.downloader')} />
      <CardContent>
        <form className={classes.searchForm} onSubmit={handleSubmit}>
          <TextField
            id="downloader-search"
            className={classes.searchInput}
            variant="outlined"
            size="small"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            label={translate('downloader.searchLabel')}
            helperText={translate('downloader.searchHelp')}
          />
          <Button
            type="submit"
            variant="contained"
            color="primary"
            disabled={searching || !query.trim()}
          >
            {searching ? (
              <CircularProgress size={24} />
            ) : (
              translate(
                isLink(query.trim())
                  ? 'ra.action.download'
                  : 'ra.action.search',
              )
            )}
          </Button>
        </form>

        {results && (
          <div className={classes.section}>
            <Typography variant="h6">
              {translate('downloader.results')}
            </Typography>
            {results.length === 0 && (
              <Typography color="textSecondary">
                {translate('downloader.noResults')}
              </Typography>
            )}
            <List>
              {results.map((album) => {
                const job = jobFor(album.url)
                return (
                  <ListItem key={album.url} className={classes.item}>
                    <Cover src={album.artworkUrl} className={classes.cover} />
                    <ListItemText
                      primary={album.title}
                      secondary={[album.artist, album.year || null]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                    <ListItemSecondaryAction>
                      <Button
                        variant="outlined"
                        size="small"
                        disabled={Boolean(job) && job.status !== 'failed'}
                        onClick={() => download(album)}
                      >
                        {downloadLabel(job)}
                      </Button>
                    </ListItemSecondaryAction>
                  </ListItem>
                )
              })}
            </List>
          </div>
        )}

        {jobs.length > 0 && (
          <div className={classes.section}>
            <Typography variant="h6">
              {translate('downloader.downloads')}
            </Typography>
            <List>
              {jobs.map((job) => (
                <ListItem key={job.id}>
                  <Cover src={job.artworkUrl} className={classes.cover} />
                  <ListItemText
                    disableTypography
                    primary={
                      <Typography>
                        {[job.title || job.url, job.artist]
                          .filter(Boolean)
                          .join(' · ')}
                      </Typography>
                    }
                    secondary={
                      <>
                        <Typography
                          variant="body2"
                          color={
                            job.status === 'failed' ? 'error' : 'textSecondary'
                          }
                        >
                          {jobStatus(job, translate)}
                        </Typography>
                        <JobProgress job={job} className={classes.progress} />
                      </>
                    }
                  />
                </ListItem>
              ))}
            </List>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default Downloader
