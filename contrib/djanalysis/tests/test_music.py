import numpy as np

from djanalysis.music import bars_from_downbeats, camelot, phrase_boundaries, same_camelot_number, tempo_from_beats


def test_camelot_wheel():
    assert camelot(0, False) == "8B"   # C
    assert camelot(9, True) == "8A"    # Am
    assert camelot(7, False) == "9B"   # G
    assert camelot(11, False) == "1B"  # B
    assert camelot(8, True) == "1A"    # G#m
    assert camelot(5, False) == "7B"   # F
    assert camelot(2, True) == "7A"    # Dm
    assert same_camelot_number((0, False), (9, True))
    assert not same_camelot_number((0, False), (7, False))


def test_tempo_from_steady_and_wobbly_beats():
    beats = np.arange(0, 60, 0.5)  # 120 BPM
    bpm, cv = tempo_from_beats(beats)
    assert abs(bpm - 120) < 0.01 and cv < 1e-6
    rng = np.random.default_rng(1)
    wobbly = np.cumsum(0.5 + rng.normal(0, 0.05, 120))
    _, cv = tempo_from_beats(wobbly)
    assert cv > 0.05
    assert tempo_from_beats(np.array([0.0, 1.0]))[0] == 0


def test_bars_from_downbeats():
    bars = bars_from_downbeats(np.array([1.0, 3.0, 5.0]), duration=6.5)
    assert bars == [(1.0, 3.0), (3.0, 5.0), (5.0, 6.5)]


def test_phrase_boundaries_find_section_changes_on_the_grid():
    quiet, loud = [0.1, 0.1, 0.1], [1.0, 0.8, 0.5]
    feats = np.array([quiet] * 16 + [loud] * 32 + [quiet] * 16)
    feats += np.random.default_rng(0).normal(0, 0.01, feats.shape)
    b = phrase_boundaries(feats)
    assert b[0] == 0
    assert 16 in b and 48 in b
    assert all(x % 4 == 0 for x in b)


def test_fit_grid_handles_half_time_switches_and_drift():
    from djanalysis.music import fit_grid

    # 70 BPM, with a stretch the tracker hears in double time.
    p = 60 / 70
    beats = list(np.arange(0, 40) * p)
    beats += list(beats[-1] + np.arange(1, 41) * p / 2)
    beats += list(beats[-1] + np.arange(1, 41) * p)
    g = fit_grid(np.array(beats))
    assert abs(g["bpm"] - 70) < 0.05
    assert g["local_jitter"] < 0.002
    assert 0.2 < g["octave_switch_share"] < 0.5

    # A band speeding up from 120 to 126 BPM over the song: steady locally, drifting globally.
    periods = np.linspace(0.5, 0.5 * 120 / 126, 400)
    g = fit_grid(np.concatenate([[0], np.cumsum(periods)]))
    assert g["local_jitter"] < 0.005
    assert g["drift"] > g["local_jitter"] * 5


def test_fit_grid_flags_free_time():
    from djanalysis.music import fit_grid

    rng = np.random.default_rng(3)
    g = fit_grid(np.cumsum(rng.uniform(0.3, 1.4, 120)))
    assert g["local_jitter"] > 0.03
