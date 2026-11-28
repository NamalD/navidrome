import { CHANGE_GAIN, CHANGE_PREAMP } from '../actions'

const GAIN_KEY = 'gainMode'
const PREAMP_KEY = 'preAmp'

const getPreAmp = () => {
  const storage = localStorage.getItem(PREAMP_KEY)

  if (storage === null) {
    return 0
  } else {
    const asFloat = parseFloat(storage)
    return isNaN(asFloat) ? 0 : asFloat
  }
}

const initialState = {
  // Album gain unless the user picked otherwise: the library is tagged (contrib/replaygain), and files without
  // tags play unchanged.
  gainMode: localStorage.getItem(GAIN_KEY) || 'album',
  preAmp: getPreAmp(),
}

export const replayGainReducer = (
  previousState = initialState,
  { type, payload },
) => {
  switch (type) {
    case CHANGE_GAIN: {
      localStorage.setItem(GAIN_KEY, payload)
      return {
        ...previousState,
        gainMode: payload,
      }
    }
    case CHANGE_PREAMP: {
      const value = parseFloat(payload)
      if (isNaN(value)) {
        return previousState
      }
      localStorage.setItem(PREAMP_KEY, payload)
      return {
        ...previousState,
        preAmp: value,
      }
    }
    default:
      return previousState
  }
}
