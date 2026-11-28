import { useEffect, useRef, useState } from 'react'
import { GaplessEngine } from './engine'
import { attachGaplessFacade } from './mediaFacade'
import { createSessionKeeper } from './sessionKeeper'
import { createDecisionService } from '../../transcode/decisionService'
import { fetchTranscodeDecision } from '../../transcode/fetchDecision'
import { calculateGain } from '../../utils/calculateReplayGain'

export const isGaplessSupported = () =>
  typeof window !== 'undefined' &&
  typeof window.AudioContext === 'function' &&
  typeof window.ReadableStream === 'function' &&
  typeof window.HTMLMediaElement === 'function'

// 2 ms of silence as the engine hands FLAC to the browser: a bare STREAMINFO header and whole frames.
const PROBE_FLAC =
  'ZkxhQ4AAACIAQABAAAAMAAAMCsRA8AAAAAAAAAAAAAAAAAAAAAAAAAAA//hpCAA/oAAAAI45//hpCAEXbQAAAB7b'

let flacProbe = null

// Whether this browser's Web Audio can decode FLAC. Not every one can (WebKit on Linux needs GStreamer's FLAC
// plugin), and without it the engine could play nothing at all, so the player then stays on the element.
export const canDecodeFlac = () => {
  if (!flacProbe) {
    flacProbe = (async () => {
      try {
        const ctx = new window.OfflineAudioContext(1, 1, 44100)
        const bytes = Uint8Array.from(window.atob(PROBE_FLAC), (c) =>
          c.charCodeAt(0),
        )
        const buffer = await ctx.decodeAudioData(bytes.buffer)
        return buffer.length > 0
      } catch {
        return false
      }
    })()
  }
  return flacProbe
}

// The engine decodes FLAC itself, so it asks the server for FLAC whatever the browser could play: FLAC files
// as they are, everything else (ALAC, WAV, MP3...) converted to FLAC. Lossless sources stay lossless.
const FLAC_PROFILE = {
  name: 'NavidromeUI',
  platform: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  directPlayProfiles: [
    { containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'] },
  ],
  transcodingProfiles: [
    { container: 'flac', audioCodec: 'flac', protocol: 'http' },
  ],
  codecProfiles: [],
}

const flacDecisions = createDecisionService(fetchTranscodeDecision)
flacDecisions.setProfile(FLAC_PROFILE)

// The song a stream URL plays (subsonic `stream?id=` or `getTranscodeStream?mediaId=`), or null for any
// other URL, such as an internet radio station.
export const songIdFromStreamUrl = (src) => {
  let url
  try {
    url = new URL(src, window.location.href)
  } catch {
    return null
  }
  if (url.origin !== window.location.origin) return null
  const command = url.pathname
    .split('/')
    .pop()
    .replace(/\.view$/, '')
  if (command === 'stream') return url.searchParams.get('id')
  if (command === 'getTranscodeStream') {
    return url.searchParams.get('mediaType') === 'song'
      ? url.searchParams.get('mediaId')
      : null
  }
  return null
}

// The queue item after the current one, as the player will move to it at the end of a track. None in shuffle
// mode, where the player only picks the next track once this one ends.
export const nextQueueItem = (playerState) => {
  const { queue, current, mode } = playerState
  if (mode === 'shufflePlay') return null
  const index = queue.findIndex((item) => item.uuid === current?.uuid)
  if (index < 0) return null
  let next
  if (mode === 'singleLoop') next = queue[index]
  else if (index + 1 < queue.length) next = queue[index + 1]
  else if (mode === 'orderLoop') next = queue[0]
  if (!next || next.isRadio) return null
  return next
}

const trackFor = (item, gainInfo) => ({
  key: item.trackId,
  url: () => flacDecisions.resolveStreamUrl(item.trackId),
  gain: calculateGain(gainInfo, item.song || {}),
  duration: item.duration,
})

// Plays songs in the player gaplessly (see engine.js) while `enabled`, by putting the engine behind the
// player's <audio> element (mediaFacade.js). Radio keeps playing through the element. Returns true while it
// does, false when it doesn't, and null while it is still finding out whether the browser can decode FLAC.
export const useGaplessPlayback = ({
  audioInstance,
  playerState,
  gainInfo,
  enabled,
}) => {
  const engineRef = useRef(null)
  const latest = useRef({ playerState, gainInfo })
  latest.current = { playerState, gainInfo }
  const wanted = enabled && !!audioInstance && isGaplessSupported()
  const [decodes, setDecodes] = useState(null)

  useEffect(() => {
    if (!wanted || decodes !== null) return undefined
    let live = true
    canDecodeFlac().then((ok) => live && setDecodes(ok))
    return () => {
      live = false
    }
  }, [wanted, decodes])

  useEffect(() => {
    if (!wanted || !decodes) return undefined
    const engine = new GaplessEngine()
    const keeper = createSessionKeeper()
    const resolveTrack = (src) => {
      const id = songIdFromStreamUrl(src)
      if (!id) return null
      const { playerState: ps, gainInfo: gi } = latest.current
      const item = (ps.current?.trackId === id && ps.current) ||
        ps.queue.find((i) => i.trackId === id) || { trackId: id }
      if (item.isRadio) return null
      return trackFor(item, gi)
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
  }, [wanted, decodes, audioInstance])

  // Line up the next track whenever the queue, the current track or the repeat mode changes.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    const next = nextQueueItem(playerState)
    engine.setNext(next ? trackFor(next, gainInfo) : null)
  }, [playerState, gainInfo, wanted, decodes, audioInstance])

  // Apply ReplayGain to the playing track when the setting changes.
  useEffect(() => {
    const engine = engineRef.current
    const current = playerState.current
    if (!engine || !current?.trackId || engine.currentKey !== current.trackId) {
      return
    }
    engine.setGain(current.trackId, calculateGain(gainInfo, current.song || {}))
  }, [playerState, gainInfo, wanted, decodes, audioInstance])

  if (!wanted) return false
  return decodes
}
