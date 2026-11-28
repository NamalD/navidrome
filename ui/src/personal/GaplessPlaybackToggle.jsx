import { useEffect, useState } from 'react'
import { useTranslate } from 'react-admin'
import { useDispatch, useSelector } from 'react-redux'
import {
  FormControl,
  FormControlLabel,
  FormHelperText,
  Switch,
} from '@material-ui/core'
import { setGaplessPlayback } from '../actions'
import { canDecodeFlac, isGaplessSupported } from '../audioplayer/gapless'

export const GaplessPlaybackToggle = () => {
  const translate = useTranslate()
  const dispatch = useDispatch()
  const enabled = useSelector(
    (state) => state.settings.gaplessPlayback !== false,
  )
  const [decodes, setDecodes] = useState(null)
  useEffect(() => {
    if (!isGaplessSupported()) return undefined
    let live = true
    canDecodeFlac().then((ok) => live && setDecodes(ok))
    return () => {
      live = false
    }
  }, [])
  // Until the check is done, assume it will pass, so the switch doesn't flicker.
  const supported = isGaplessSupported() && decodes !== false

  return (
    <FormControl>
      <FormControlLabel
        control={
          <Switch
            id={'gaplessPlayback'}
            color="primary"
            checked={supported && enabled}
            disabled={!supported}
            onChange={(event) =>
              dispatch(setGaplessPlayback(event.target.checked))
            }
          />
        }
        label={
          <span>{translate('menu.personal.options.gaplessPlayback')}</span>
        }
      />
      <FormHelperText>
        {translate(
          supported
            ? 'menu.personal.options.gaplessPlaybackHelp'
            : 'menu.personal.options.gaplessNotAvailable',
        )}
      </FormHelperText>
    </FormControl>
  )
}
