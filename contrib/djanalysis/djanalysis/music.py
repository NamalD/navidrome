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


def fit_grid(beats: np.ndarray, window: int = 32) -> dict | None:
    """Fits a beat grid that survives the tracker hopping between half and double time.

    Each beat interval is counted as 1, 2 or ½ beats of one period (the median interval, folded), giving every beat
    an index on a single grid. A straight line through (index, time) gives the tempo and the first beat's time;
    the steadiness is the median, over windows of `window` beats, of how far beats sit from a local straight line
    (seconds). Live drummers drift over a song but stay steady over a few bars, which is what a blend needs.
    """
    if len(beats) < 8:
        return None
    ibi = np.diff(beats)
    period = float(np.median(ibi))
    # Fold: an interval near period/2 is half a beat, near 2*period two beats.
    steps = np.maximum(np.round(ibi / period * 2) / 2, 0.5)
    idx = np.concatenate([[0.0], np.cumsum(steps)])
    slope, intercept = np.polyfit(idx, beats, 1)
    local = []
    for s in range(0, len(beats) - window + 1, window // 2):
        i, t = idx[s:s + window], beats[s:s + window]
        a, b = np.polyfit(i, t, 1)
        local.append(float(np.sqrt(np.mean((t - (a * i + b)) ** 2))))
    if not local:
        a, b = slope, intercept
        local = [float(np.sqrt(np.mean((beats - (a * idx + b)) ** 2)))]
    half_time_share = float(np.mean(steps != 1))
    return {
        "bpm": round(60.0 / float(slope), 3),
        "first_beat": round(float(intercept), 4),
        "local_jitter": round(float(np.median(local)), 4),
        "drift": round(float(np.sqrt(np.mean((beats - (slope * idx + intercept)) ** 2))), 4),
        "octave_switch_share": round(half_time_share, 3),
    }
