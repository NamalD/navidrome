"""Pure helpers for keys, beat grids and phrases. No audio libraries here, so they are cheap to test."""

from __future__ import annotations

import numpy as np

PITCH_CLASSES = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6,
    "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11,
}
NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


def camelot(pitch_class: int, minor: bool) -> str:
    """Camelot wheel code: C major is 8B, A minor 8A; each step round the wheel is a fifth."""
    major_pc = (pitch_class + 3) % 12 if minor else pitch_class
    number = (major_pc * 7) % 12 + 7
    number = number % 12 + 1
    return f"{number}{'A' if minor else 'B'}"


def key_name(pitch_class: int, minor: bool) -> str:
    return NAMES[pitch_class] + ("m" if minor else "")


def same_camelot_number(a: tuple[int, bool], b: tuple[int, bool]) -> bool:
    """Same key, or relative major and minor (C and Am)."""
    return camelot(*a)[:-1] == camelot(*b)[:-1]


def tempo_from_beats(beats: np.ndarray) -> tuple[float, float]:
    """BPM from the median beat interval, and how steady the tempo is (coefficient of variation of the intervals,
    0 for a machine-steady track). Returns (0, inf) when there are too few beats."""
    if len(beats) < 8:
        return 0.0, float("inf")
    ibi = np.diff(beats)
    med = float(np.median(ibi))
    if med <= 0:
        return 0.0, float("inf")
    # Ignore outliers (dropped or doubled beats) when judging steadiness.
    core = ibi[(ibi > 0.5 * med) & (ibi < 1.5 * med)]
    cv = float(np.std(core) / np.mean(core)) if len(core) > 1 else float("inf")
    return 60.0 / med, cv


def bars_from_downbeats(downbeats: np.ndarray, duration: float) -> list[tuple[float, float]]:
    """Bars as (start, end) seconds between consecutive downbeats; the last bar ends at the next expected downbeat
    or the end of the track."""
    if len(downbeats) == 0:
        return []
    bars = [(float(a), float(b)) for a, b in zip(downbeats[:-1], downbeats[1:])]
    if len(downbeats) > 1:
        last_len = float(np.median(np.diff(downbeats)))
        bars.append((float(downbeats[-1]), min(float(downbeats[-1]) + last_len, duration)))
    return bars


def phrase_boundaries(bar_features: np.ndarray, min_bars: int = 8, grid: int = 4) -> list[int]:
    """Bar indices where a new section starts, from how much each bar's features differ from the bars before it.

    bar_features is (bars, features), e.g. band energies per bar. A boundary must be at least min_bars after the
    previous one and is snapped to the nearest multiple of `grid` bars, since dance music changes on 4/8/16-bar
    phrases. Bar 0 is always a boundary.
    """
    n = len(bar_features)
    if n == 0:
        return []
    f = np.asarray(bar_features, dtype=float)
    # Normalise each feature so loud bands don't dominate.
    f = (f - f.mean(axis=0)) / (f.std(axis=0) + 1e-9)
    novelty = np.zeros(n)
    w = 4
    for i in range(w, n - w + 1):
        before, after = f[i - w:i].mean(axis=0), f[i:i + w].mean(axis=0)
        novelty[i] = float(np.linalg.norm(after - before))
    threshold = novelty.mean() + 0.75 * novelty.std() if n > 2 * w else np.inf
    out = [0]
    for i in np.argsort(-novelty):
        if novelty[i] < threshold:
            break
        snapped = int(round(i / grid) * grid)
        if 0 < snapped < n and all(abs(snapped - b) >= min_bars for b in out):
            out.append(snapped)
    return sorted(out)


SNAP = 0.2  # of a beat: how far off the grid a detected beat may be and still count


def _refit(beats: np.ndarray, t0: float, period: float, max_k: float) -> tuple[float, float, np.ndarray] | None:
    """Least-squares line t = t0 + k * period through the beats within SNAP of the grid and max_k beats of t0."""
    k = np.round((beats - t0) / period)
    on = (np.abs(k) <= max_k) & (np.abs(beats - (t0 + k * period)) <= SNAP * period)
    if on.sum() < 4:
        return None
    slope, intercept = np.polyfit(k[on], beats[on], 1)
    return float(intercept), float(slope), on


def majority_grid(beats: np.ndarray, anchors: int = 16) -> tuple[float, float, np.ndarray] | None:
    """The straight beat grid (t0, period, mask of beats on it) that most beats sit on.

    Beats are placed on it by their distance in periods, not counted, so a beat the tracker missed or added
    doesn't shift the ones after it; and the grid is fitted near an anchor first and widened, because the first
    period (the median gap, in whole 20 ms frames) can be a few percent off. Anchors spread through the song
    vote: a stretch the tracker spent on the off-beat (a drumless intro, say) is off the winner by half a beat.
    The browser's mixer fits grids the same way (ui/src/audioplayer/dj/warp.js).
    """
    if len(beats) < 8:
        return None
    period0 = float(np.median(np.diff(beats)))
    best = None
    for a in np.linspace(0, len(beats) - 1, min(anchors, len(beats))).round().astype(int):
        g: tuple[float, float, np.ndarray] | None = (float(beats[a]), period0, np.ones(0, bool))
        for max_k in (4, 8, 16, 32, 64, 128, 256, 512, np.inf):
            for _ in range(2):
                g = g and _refit(beats, g[0], g[1], max_k)
        if g and (best is None or g[2].sum() > best[2].sum()):
            best = g
    return best


def fit_grid(beats: np.ndarray, window: int = 32) -> dict | None:
    """Fits a beat grid that survives the tracker hopping between half and double time, or onto the off-beat.

    The tempo and first beat come from the grid most beats sit on (majority_grid). The steadiness is separate:
    each beat interval is counted as 1, 2 or ½ beats of one period (the median interval, folded), giving every
    beat an index; local_jitter is the median, over windows of `window` beats, of how far beats sit from a
    local straight line (seconds). Live drummers drift over a song but stay steady over a few bars, which is
    what a blend needs.
    """
    if len(beats) < 8:
        return None
    ibi = np.diff(beats)
    period = float(np.median(ibi))
    # Fold: an interval near period/2 is half a beat, near 2*period two beats.
    steps = np.maximum(np.round(ibi / period * 2) / 2, 0.5)
    idx = np.concatenate([[0.0], np.cumsum(steps)])
    local = []
    for s in range(0, len(beats) - window + 1, window // 2):
        i, t = idx[s:s + window], beats[s:s + window]
        a, b = np.polyfit(i, t, 1)
        local.append(float(np.sqrt(np.mean((t - (a * i + b)) ** 2))))
    if not local:
        a, b = np.polyfit(idx, beats, 1)
        local = [float(np.sqrt(np.mean((beats - (a * idx + b)) ** 2)))]
    half_time_share = float(np.mean(steps != 1))
    g = majority_grid(beats)
    if g is None:
        return None
    t0, slope, on = g
    first = t0 + np.round((beats[0] - t0) / slope) * slope
    k = np.round((beats - t0) / slope)
    return {
        "bpm": round(60.0 / slope, 3),
        "first_beat": round(float(first), 4),
        "local_jitter": round(float(np.median(local)), 4),
        # How far all the beats sit from the one grid (s), and how many sit on it.
        "drift": round(float(np.sqrt(np.mean((beats - (t0 + k * slope)) ** 2))), 4),
        "on_grid": round(float(on.mean()), 3),
        "octave_switch_share": round(half_time_share, 3),
    }
