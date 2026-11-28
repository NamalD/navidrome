import {
  SET_ENDLESS_PLAY,
  SET_GAPLESS_PLAYBACK,
  SET_NOTIFICATIONS_STATE,
  SET_OMITTED_FIELDS,
  SET_SIDEBAR_PLAYLISTS_FAVOURITES,
  SET_TOGGLEABLE_FIELDS,
} from '../actions'

const initialState = {
  notifications: false,
  toggleableFields: {},
  omittedFields: {},
  sidebarPlaylistsOnlyFavourites: false,
  endlessPlay: false,
  // Settings saved before this existed lack the key; read it as `!== false` so it defaults to on.
  gaplessPlayback: true,
}

export const settingsReducer = (previousState = initialState, payload) => {
  const { type, data } = payload
  switch (type) {
    case SET_NOTIFICATIONS_STATE:
      return {
        ...previousState,
        notifications: data,
      }
    case SET_TOGGLEABLE_FIELDS:
      return {
        ...previousState,
        toggleableFields: {
          ...previousState.toggleableFields,
          ...data,
        },
      }
    case SET_OMITTED_FIELDS:
      return {
        ...previousState,
        omittedFields: {
          ...previousState.omittedFields,
          ...data,
        },
      }
    case SET_SIDEBAR_PLAYLISTS_FAVOURITES:
      return {
        ...previousState,
        sidebarPlaylistsOnlyFavourites: data,
      }
    case SET_ENDLESS_PLAY:
      return {
        ...previousState,
        endlessPlay: data,
      }
    case SET_GAPLESS_PLAYBACK:
      return {
        ...previousState,
        gaplessPlayback: data,
      }
    default:
      return previousState
  }
}
