import { useEffect, useRef } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import subsonic from '../subsonic'
import { addTracks } from '../actions'
import { processSongsForPlayback } from '../common/playbackActions'

// How many tracks each continuation adds to the queue
export const ENDLESS_PLAY_BATCH_SIZE = 10
const SIMILAR_POOL_SIZE = 100
const RANDOM_POOL_SIZE = 200

const songsFrom = (res, key) => {
  const data = res.json['subsonic-response']
  if (data.status !== 'ok') {
    throw new Error(data.error?.message || 'Unknown error')
  }
  return data[key]?.song || []
}

// Picks the songs that continue the queue after `seedId`: songs similar to it
// that are not queued yet, topped up with random unqueued songs. Once the whole
// library is queued, random songs repeat so playback never runs dry.
export const fetchContinuation = async (
  seedId,
  queuedIds,
  count = ENDLESS_PLAY_BATCH_SIZE,
) => {
  const taken = new Set(queuedIds)
  const picked = []
  const pick = (songs) => {
    for (const song of songs) {
      if (picked.length >= count) break
      if (!taken.has(song.id)) {
        taken.add(song.id)
        picked.push(song)
      }
    }
  }

  try {
    const res = await subsonic.getSimilarSongs2(seedId, SIMILAR_POOL_SIZE)
    pick(songsFrom(res, 'similarSongs2'))
  } catch {
    // No similar songs available (e.g. no agent configured): use random ones
  }
  if (picked.length >= count) return picked

  const res = await subsonic.getRandomSongs(RANDOM_POOL_SIZE)
  const random = songsFrom(res, 'randomSongs')
  pick(random)
  if (picked.length > 0) return picked

  return random.filter((song) => song.id !== seedId).slice(0, count)
}

// While the "endless play" setting is on, extends the queue when its last
// track starts playing, so playback continues instead of stopping.
export const useEndlessPlay = (playerState) => {
  const dispatch = useDispatch()
  const enabled = useSelector((state) => state.settings.endlessPlay || false)
  const { queue, current, mode } = playerState

  // The effect reads the queue through a ref, so it only runs when the seed changes
  const queueRef = useRef(queue)
  queueRef.current = queue

  const last = queue[queue.length - 1]
  // In shuffle and single-loop modes the end of the queue is never reached
  const isSeed =
    enabled &&
    !!current?.uuid &&
    !current.isRadio &&
    last?.uuid === current.uuid &&
    mode !== 'shufflePlay' &&
    mode !== 'singleLoop'
  const seedUuid = isSeed ? current.uuid : null
  const seedId = isSeed ? current.trackId : null

  useEffect(() => {
    if (!seedUuid) return
    let cancelled = false
    const queuedIds = queueRef.current.map((item) => item.trackId)
    fetchContinuation(seedId, queuedIds)
      .then((songs) => {
        if (cancelled || songs.length === 0) return
        const { songData, ids } = processSongsForPlayback(songs)
        dispatch(addTracks(songData, ids))
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.log('Endless play error:', e)
      })
    return () => {
      cancelled = true
    }
  }, [seedUuid, seedId, dispatch])
}
