import { useEffect, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'
import { DjEngine } from './engine'
import { attachGaplessFacade } from '../gapless/mediaFacade'
import { createSessionKeeper } from '../gapless/sessionKeeper'
import {
  canDecodeFlac,
  isGaplessSupported,
  nextQueueItem,
  songIdFromStreamUrl,
} from '../gapless'
import { createDecisionService } from '../../transcode/decisionService'
import { fetchTranscodeDecision } from '../../transcode/fetchDecision'
import { httpClient } from '../../dataProvider'
import { REST_URL } from '../../consts'
import subsonic from '../../subsonic'
import { addTracks, setDjMode, setTrack } from '../../actions'
import { processSongsForPlayback } from '../../common/playbackActions'
import { fetchContinuation } from '../useEndlessPlay'

export const isDjSupported = () =>
  isGaplessSupported() && typeof window.AudioWorkletNode === 'function'

// Every song as 44.1 kHz, 16-bit FLAC: FLAC files at that rate as they are, everything else converted. The mixer
// runs at 44.1 kHz and never resamples, and hi-res files (96 and 192 kHz) download at a fraction of their size.
export const DJ_PROFILE = {
  name: 'NavidromeDJ',
  platform: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  directPlayProfiles: [
    { containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'] },
  ],
  transcodingProfiles: [
    { container: 'flac', audioCodec: 'flac', protocol: 'http' },
  ],
  codecProfiles: [
    {
      type: 'AudioCodec',
      name: 'flac',
      limitations: [
        {
          name: 'audioSamplerate',
          comparison: 'Equals',
          values: ['44100'],
          required: true,
        },
        {
          name: 'audioBitdepth',
          comparison: 'LessThanEqual',
          values: ['16'],
          required: true,
        },
      ],
    },
  ],
}

const djDecisions = createDecisionService(fetchTranscodeDecision)
djDecisions.setProfile(DJ_PROFILE)

const analyses = new Map()
// A song's analysis (contrib/djanalysis), or null when it has none. Kept for the session.
export const fetchAnalysis = (id) => {
  if (!analyses.has(id)) {
    const p = httpClient(`${REST_URL}/dj/analysis/${encodeURIComponent(id)}`)
      .then(({ json }) => json)
      .catch(() => null)
    analyses.set(id, p)
    if (analyses.size > 50) analyses.delete(analyses.keys().next().value)
  }
  return analyses.get(id)
}

// Asks the planner how to leave `current`: into a song of its choosing, or into `next` when given. Resolves to
// the plan (with `from` set to `current`), or null when there is none (a song not analysed, nothing left).
export const fetchPlan = async ({
  current,
  next,
  rate = 1,
  semitones = 0,
  exclude = [],
  history = [],
}) => {
  const params = new URLSearchParams({
    current,
    rate: String(rate),
    semitones: String(semitones),
  })
  if (next) params.set('next', next)
  if (exclude.length) params.set('exclude', exclude.join(','))
  if (history.length) params.set('history', history.slice(-5).join(','))
  try {
    const { json } = await httpClient(`${REST_URL}/dj/next?${params}`)
    return { ...json, from: current }
  } catch {
    return null
  }
}

const fetchSong = async (id) => {
  const res = await httpClient(subsonic.url('getSong', id))
  const data = res.json['subsonic-response']
  if (data.status !== 'ok') throw new Error(data.error?.message || 'getSong')
  return data.song
}

const planKey = (from, to) => `${from}>${to}`

const trackFor = (item, plan) => ({
  key: item.trackId,
  url: () => djDecisions.resolveStreamUrl(item.trackId),
  gain: 1,
  duration: item.duration,
  analysis: () => fetchAnalysis(item.trackId),
  plan: plan || null,
})

// "Start DJ mix" on a song (a song list record): a new queue of just that song, played in DJ mode, so the mixer
// picks every next one.
export const startDjMix = (dispatch, record) => {
  dispatch(setDjMode(true))
  dispatch(setTrack(record))
}

// While `enabled`, songs play through the DJ mixer (engine.js) behind the player's <audio> element, and the
// session keeps the queue one song ahead: when the playing song is the last, it asks the planner for the next
// and adds it; when the user queued one, it asks for the transition into that. Returns whether it is on.
export const useDjPlayback = ({ audioInstance, playerState, enabled }) => {
  const dispatch = useDispatch()
  const engineRef = useRef(null)
  const latest = useRef(playerState)
  latest.current = playerState
  const plans = useRef(new Map())
  const picking = useRef(new Set())
  const [plansVersion, setPlansVersion] = useState(0)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  const wanted = enabled && !!audioInstance && isDjSupported()
  const [decodes, setDecodes] = useState(null)
  const active = wanted && decodes === true

  // Where playback was before the engines swap (read during render, before the old one detaches), so the new
  // one carries on from there. Wanting the mixer and having it can be renders apart (the FLAC check above), and
  // the player lets go of the gapless engine on the first, so it's read on the first change and kept until
  // the swap.
  const snapshot = useRef(null)
  const wasActive = useRef(active)
  const seen = useRef({ wanted, active })
  if (
    (seen.current.wanted !== wanted || seen.current.active !== active) &&
    audioInstance
  ) {
    seen.current = { wanted, active }
    snapshot.current ??= {
      key: latest.current.current?.trackId,
      time: audioInstance.currentTime,
      playing: !audioInstance.paused,
    }
  }

  useEffect(() => {
    if (!wanted || decodes !== null) return undefined
    let live = true
    canDecodeFlac().then((ok) => live && setDecodes(ok))
    return () => {
      live = false
    }
  }, [wanted, decodes])

  useEffect(() => {
    if (!active) return undefined
    const engine = new DjEngine()
    const keeper = createSessionKeeper()
    const resolveTrack = (src) => {
      const id = songIdFromStreamUrl(src)
      if (!id) return null
      const ps = latest.current
      const item = (ps.current?.trackId === id && ps.current) ||
        ps.queue.find((i) => i.trackId === id) || { trackId: id }
      if (item.isRadio) return null
      return trackFor(item)
    }
    const detach = attachGaplessFacade(audioInstance, engine, {
      resolveTrack,
      keeper,
    })
    engineRef.current = engine
    return () => {
      engineRef.current = null
      detach()
      engine.destroy()
      keeper.destroy()
    }
  }, [active, audioInstance])

  // After switching engines, carry on where the last one was.
  useEffect(() => {
    if (wasActive.current === active) {
      // Turned off again before the mixer came on: nothing swapped.
      if (!wanted) snapshot.current = null
      return
    }
    wasActive.current = active
    const snap = snapshot.current
    snapshot.current = null
    if (!snap || !audioInstance || !snap.playing) return
    if (snap.key !== latest.current.current?.trackId) return
    const resume = () => {
      if (snap.time > 1) audioInstance.currentTime = snap.time
      audioInstance.play().catch(() => {})
    }
    if (audioInstance.readyState >= 1) resume()
    else
      audioInstance.addEventListener('loadedmetadata', resume, { once: true })
  }, [active, wanted, audioInstance])

  // Keep the next song lined up, with its transition.
  const current = playerState.current
  const next = active ? nextQueueItem(playerState) : null
  const currentId = current?.isRadio ? null : current?.trackId
  const nextId = next?.trackId
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !currentId) return undefined
    const ps = latest.current
    const index = ps.queue.findIndex((i) => i.uuid === ps.current?.uuid)
    const history = ps.queue.slice(0, Math.max(0, index)).map((i) => i.trackId)
    const request = {
      current: currentId,
      rate: engine.currentKey === currentId ? engine.currentRate : 1,
      semitones: engine.currentKey === currentId ? engine.currentSemitones : 0,
      exclude: ps.queue.map((i) => i.trackId),
      history,
    }
    if (nextId) {
      const key = planKey(currentId, nextId)
      const known = plans.current.has(key)
      engine.setNext(trackFor(next, plans.current.get(key)))
      if (known) return
      plans.current.set(key, null)
      fetchPlan({ ...request, next: nextId }).then((plan) => {
        plans.current.set(key, plan)
        if (mounted.current) setPlansVersion((v) => v + 1)
      })
      return
    }

    engine.setNext(null)
    const { mode } = ps
    if (mode === 'singleLoop' || mode === 'shufflePlay') return
    if (picking.current.has(ps.current.uuid)) return
    picking.current.add(ps.current.uuid)
    fetchPlan(request)
      .then(async (plan) => {
        let song
        if (plan) {
          song = await fetchSong(plan.songId)
          plans.current.set(planKey(currentId, plan.songId), plan)
        } else {
          // The playing song isn't analysed (or nothing fits): carry on with a similar song, played after it.
          ;[song] = await fetchContinuation(currentId, request.exclude, 1)
        }
        if (!song || !mounted.current) return
        const { songData, ids } = processSongsForPlayback([song])
        dispatch(addTracks(songData, ids))
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.log('DJ mix error:', e)
      })
    // `next` is read through nextId; plansVersion re-runs it when a plan arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, nextId, plansVersion, active, dispatch])

  return active
}
