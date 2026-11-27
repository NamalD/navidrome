// Lower case and without accents, the way the server's lyrics index folds text
const fold = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// The line of a song's lyrics that best shows why it matched `query`: the
// first one containing the most of the query's words. `lyrics` is the song's
// `lyrics` field (JSON: a list of lyrics, each with a list of lines).
export const matchingLyricsLine = (lyrics, query) => {
  let lists
  try {
    lists = typeof lyrics === 'string' ? JSON.parse(lyrics) : lyrics
  } catch {
    return ''
  }
  const words = fold(query || '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (!Array.isArray(lists) || words.length === 0) return ''

  let best = ''
  let bestScore = 0
  for (const list of lists) {
    for (const line of list?.line || []) {
      const text = fold(line?.value || '')
      const score = words.filter((word) => text.includes(word)).length
      if (score > bestScore) {
        best = line.value.trim()
        bestScore = score
      }
    }
  }
  return best
}
