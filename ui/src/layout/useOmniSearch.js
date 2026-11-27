import { useContext, useEffect, useState } from 'react'
import { DataProviderContext } from 'react-admin'
import config from '../config'

// What the omnibar searches, in the order the groups are shown. `field` is
// the filter each resource's own list view uses for its search box.
export const OMNI_SECTIONS = [
  { resource: 'artist', field: 'name', perPage: 4 },
  { resource: 'album', field: 'name', perPage: 4 },
  { resource: 'song', field: 'title', perPage: 5 },
  { resource: 'playlist', field: 'q', perPage: 3 },
]

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
          sections: sections.filter((s) => s.items.length > 0),
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
