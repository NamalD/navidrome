import { describe, expect, it } from 'vitest'
import { matchingLyricsLine } from './lyricsMatch'

const lyrics = JSON.stringify([
  {
    lang: 'eng',
    line: [
      { value: 'Hold me closer, tiny dancer' },
      { value: ' Count the headlights on the highway ' },
      { value: 'Lay me down in sheets of linen' },
    ],
  },
  { lang: 'fra', line: [{ value: 'Où sont passées les années' }] },
])

describe('matchingLyricsLine', () => {
  it('returns the line that contains the query words', () => {
    expect(matchingLyricsLine(lyrics, 'headlights')).toBe(
      'Count the headlights on the highway',
    )
  })

  it('prefers the line with the most query words', () => {
    expect(matchingLyricsLine(lyrics, 'me down linen')).toBe(
      'Lay me down in sheets of linen',
    )
  })

  it('ignores case, accents and punctuation', () => {
    expect(matchingLyricsLine(lyrics, 'OU sont, passees')).toBe(
      'Où sont passées les années',
    )
  })

  it('matches the word still being typed', () => {
    expect(matchingLyricsLine(lyrics, 'tiny danc')).toBe(
      'Hold me closer, tiny dancer',
    )
  })

  it('returns nothing when no line matches or there are no lyrics', () => {
    expect(matchingLyricsLine(lyrics, 'zzz')).toBe('')
    expect(matchingLyricsLine('[]', 'tiny')).toBe('')
    expect(matchingLyricsLine('not json', 'tiny')).toBe('')
    expect(matchingLyricsLine(undefined, 'tiny')).toBe('')
    expect(matchingLyricsLine(lyrics, ' ')).toBe('')
  })
})
