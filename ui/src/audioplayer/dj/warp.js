// Locks the incoming song's beats onto the playing song's for the length of a blend, the way DJ software syncs
// two decks. The plan alone isn't exact enough:
// - its rate comes from each song's overall BPM, a little off wherever the beat tracker hopped between half
//   and double time;
// - its start points are single detected downbeats, each up to a frame (20 ms) off;
// - and in a quiet intro or break the tracker (beat_this) can sit on the off-beat until the drums come in,
//   half a beat out, with its downbeats as wrong.
//
// A programmed song keeps one tempo for a minute or more, so for each song a straight grid is fitted through
// the beats around the blend, by the phase most of them agree on; beats off it (strays, a stretch on the
// off-beat) are left out. Most downbeats then say which grid beats start bars. The incoming deck plays at the
// rate that makes its grid's period match the playing song's, from its bar start nearest the plan's start, at
// the playing song's bar start nearest the plan's.
//
// Beats are placed on the grid by their distance in periods, not counted, since the tracker now and then
// misses one or adds one.

const SNAP = 0.2 // of a beat: how far off the grid a detected beat may be and still count
const MAX_SNAP = 0.08 // seconds a transition point may be from a detected beat
const MAX_BEND = 0.08 // how far the locked rate may stray from the planned rate
const MAX_RMS = 0.045 // seconds: beats scattered more than this around the grid aren't steady enough to lock
const BEFORE_BEATS = 32 // beats of the playing song before the blend that count towards its grid
const AFTER_BEATS = 64 // beats of the next song after the blend that count towards its grid
const ANCHORS = 16 // beats tried as the grid's starting point

// Index of the value in sorted `xs` nearest to `x`.
export const nearestIndex = (xs, x) => {
  let lo = 0
  let hi = xs.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] < x) lo = mid
    else hi = mid
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

// The median gap between the beats around song time `t`: a rough local beat period.
export const periodNear = (beats, t) => {
  const i = nearestIndex(beats, t)
  const gaps = []
  for (let j = Math.max(0, i - 8); j < Math.min(beats.length - 1, i + 8); j++) {
    gaps.push(beats[j + 1] - beats[j])
  }
  return median(gaps)
}

// The grid's index of song time `t`, and the time of index k.
const indexOf = (g, t) => Math.round((t - g.t0) / g.period)
const timeAt = (g, k) => g.t0 + k * g.period
const offGrid = (g, t) => Math.abs(t - timeAt(g, indexOf(g, t)))

// Least-squares line t = t0 + k * period through the beats that sit within SNAP of the grid given and at most
// `maxK` beats from t0.
const refit = (beats, g, maxK) => {
  let n = 0
  let sk = 0
  let sy = 0
  let skk = 0
  let sky = 0
  for (const b of beats) {
    const k = indexOf(g, b)
    if (Math.abs(k) > maxK || offGrid(g, b) > SNAP * g.period) continue
    n++
    sk += k
    sy += b
    skk += k * k
    sky += k * b
  }
  if (n < 4) return null
  const period = (n * sky - sk * sy) / (n * skk - sk * sk)
  return { t0: (sy - period * sk) / n, period, n }
}

// A steady beat grid { t0, period, n, rms } through the beats between song times `from` and `to` (n of them on
// it), or null when they don't hold one (too few, or too scattered).
export const fitGrid = (beats, from, to) => {
  const sel = beats.filter((b) => b >= from && b <= to)
  if (sel.length < 8) return null
  const period0 = median(sel.slice(1).map((b, i) => b - sel[i]))
  // The gaps are whole frames (20 ms), so the first period can be a few percent off: fit near the anchor first
  // and widen, so the grid never strays far enough to lose the beats. Anchors are spread through the stretch
  // and the grid most beats sit on wins, so a stretch on the off-beat is outvoted.
  let best = null
  for (let a = 0; a < ANCHORS; a++) {
    const anchor = sel[Math.round((a * (sel.length - 1)) / (ANCHORS - 1))]
    let g = { t0: anchor, period: period0 }
    for (const maxK of [4, 8, 16, 32, 64, 128, Infinity]) {
      g = g && refit(sel, g, maxK)
      g = g && refit(sel, g, maxK)
    }
    if (g && (!best || g.n > best.n)) best = g
  }
  // A third of the beats is enough: where the tracker sat on the off-beat, its beats are off this grid by half
  // a beat, though the period is the same.
  if (!best || best.n < Math.max(12, sel.length / 3)) return null
  let sq = 0
  for (const b of sel) {
    const d = offGrid(best, b)
    if (d <= SNAP * best.period) sq += d * d
  }
  const rms = Math.sqrt(sq / best.n)
  return rms <= MAX_RMS ? { ...best, rms } : null
}

// The grid's beat nearest song time `t`.
export const gridBeat = (g, t) => timeAt(g, indexOf(g, t))

// Which grid indices (mod 4) start bars, by the downbeats between `from` and `to` that sit on the grid; null
// when none do.
export const barPhase = (g, downbeats, from, to) => {
  const votes = [0, 0, 0, 0]
  for (const d of downbeats ?? []) {
    if (d < from || d > to || offGrid(g, d) > SNAP * g.period) continue
    votes[((indexOf(g, d) % 4) + 4) % 4]++
  }
  const most = Math.max(...votes)
  return most > 0 ? votes.indexOf(most) : null
}

// The grid's bar start nearest song time `t` (its beat nearest `t` when the bars aren't known).
export const barStart = (g, phase, t) => {
  const k = indexOf(g, t)
  if (phase === null) return timeAt(g, k)
  let best = null
  for (let j = k - 2; j <= k + 2; j++) {
    if (((j % 4) + 4) % 4 !== phase) continue
    if (
      best === null ||
      Math.abs(timeAt(g, j) - t) < Math.abs(timeAt(g, best) - t)
    )
      best = j
  }
  return timeAt(g, best)
}

// Returns [{ t, input, rate }]: from context time t the incoming deck plays from song time `input` at `rate`;
// the last entry, at `endAt`, carries on at `rateB`; and `lock` ({ a, b }: each grid, the beats on it, its
// indices (mod 4) that start bars, and how far each start point moved from the plan's). Or null when the beats don't allow it (the transition points not on
// beats, no steady grid in either song, or tempos that don't pair up), and the plan stands.
//
// aBeats/bBeats, aDownbeats/bDownbeats: from the analyses (song seconds); outStart/inStart: the plan's
// downbeats in each; endAt: context time the blend ends; aTimeOf: song time in A -> context time;
// rateA/rateB: the decks' planned rates.
export const beatWarp = ({
  aBeats,
  bBeats,
  aDownbeats,
  bDownbeats,
  outStart,
  inStart,
  endAt,
  aTimeOf,
  rateA,
  rateB,
}) => {
  if (!(aBeats?.length >= 8) || !(bBeats?.length >= 8)) return null
  if (Math.abs(aBeats[nearestIndex(aBeats, outStart)] - outStart) > MAX_SNAP) {
    return null
  }
  if (Math.abs(bBeats[nearestIndex(bBeats, inStart)] - inStart) > MAX_SNAP) {
    return null
  }
  const span = endAt - aTimeOf(outStart) // context seconds of blend
  const roughA = periodNear(aBeats, outStart)
  const roughB = periodNear(bBeats, inStart)
  const aFrom = outStart - BEFORE_BEATS * roughA
  const aTo = outStart + span * rateA + 4 * roughA
  const bFrom = inStart - roughB / 2
  const bTo = inStart + span * rateB + AFTER_BEATS * roughB
  const ga = fitGrid(aBeats, aFrom, aTo)
  const gb = fitGrid(bBeats, bFrom, bTo)
  if (!ga || !gb) return null

  // Beat periods as heard; B's may be half or double A's (the analysis heard one song in half time).
  const heardA = ga.period / rateA
  const q = gb.period / rateB / heardA
  let ratio // B beats per A beat
  if (Math.abs(q - 1) < 0.2) ratio = 1
  else if (Math.abs(q - 2) < 0.4) ratio = 0.5
  else if (Math.abs(q - 0.5) < 0.1) ratio = 2
  else return null
  const rate = (gb.period * ratio) / heardA
  if (!(Math.abs(rate / rateB - 1) <= MAX_BEND)) return null

  const barA = barPhase(ga, aDownbeats, aFrom, aTo)
  const barB = barPhase(gb, bDownbeats, bFrom, bTo)
  const beatA = barStart(ga, barA, outStart)
  const beatB = barStart(gb, barB, inStart)
  const t = aTimeOf(beatA)
  const out = [
    { t, input: beatB, rate },
    { t: endAt, input: beatB + (endAt - t) * rate, rate: rateB },
  ]
  out.lock = {
    a: { n: ga.n, moved: beatA - outStart, grid: ga, bar: barA },
    b: { n: gb.n, moved: beatB - inStart, grid: gb, bar: barB },
  }
  return out
}
