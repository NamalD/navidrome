import { useContext, useEffect, useState } from 'react'
import { DataProviderContext } from 'react-admin'
import config from '../config'

// What the omnibar searches, in the order the groups are shown. `field` is
// the filter the resource's list view takes for that search. The lyrics group
// lists songs too, the ones whose lyrics match.
export const OMNI_SECTIONS = [
  { key: 'artist', resource: 'artist', field: 'name', perPage: 4 },
  { key: 'album', resource: 'album', field: 'name', perPage: 4 },
  { key: 'song', resource: 'song', field: 'title', perPage: 5 },
  { key: 'playlist', resource: 'playlist', field: 'q', perPage: 3 },
  { key: 'lyrics', resource: 'song', field: 'lyrics', perPage: 4 },
]

// A song found by its title is not repeated under the lyrics
const withoutRepeatedSongs = (sections) => {
  const songs = sections.find((s) => s.key === 'song')
  const listed = new Set((songs?.items || []).map((song) => song.id))
  return sections.map((s) =>
    s.key === 'lyrics'
      ? { ...s, items: s.items.filter((song) => !listed.has(song.id)) }
      : s,
  )
}

const EMPTY = { sections: [], loading: false, query: '' }

// Searches every section for `query` (debounced) and returns the sections
// that have matches. `query` in the result is the one the sections answer.
export const useOmniSearch = (query) => {
  // The data provider itself, not useDataProvider(): that hook reports every
  // request to the Redux store (five actions each, and the records are merged
  // into the resource's list data), which re-renders the whole page several
  // times per search and makes typing stutter.
  const dataProvider = useContext(DataProviderContext)
  const [state, setState] = useState(EMPTY)
  const q = query.trim()

  useEffect(() => {
    if (!q) {
      setState(EMPTY)
      return
    }
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true }))
    const timer = setTimeout(() => {
      Promise.all(
        OMNI_SECTIONS.map((section) =>
          dataProvider
            .getList(section.resource, {
              pagination: { page: 1, perPage: section.perPage },
              // No sort: the server then orders matches by relevance
              sort: {},
              filter: { [section.field]: q },
            })
            .then(({ data, total }) => ({ ...section, items: data, total }))
            .catch(() => ({ ...section, items: [], total: 0 })),
        ),
      ).then((sections) => {
        if (cancelled) return
        setState({
          sections: withoutRepeatedSongs(sections).filter(
            (s) => s.items.length > 0,
          ),
          loading: false,
          query: q,
        })
      })
    }, config.uiSearchDebounceMs)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q, dataProvider])

  return state
}
