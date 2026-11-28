import numpy as np

from djanalysis.analyse import SR, band_energies


def test_band_energies_are_finite_for_short_and_silent_bars():
    audio = np.concatenate([np.zeros(SR), np.sin(np.arange(SR) * 2 * np.pi * 60 / SR)]).astype(np.float32)
    bars = [(0.0, 1.0), (1.0, 2.0), (1.0, 1.0 + 300 / SR), (1.5, 1.5)]
    e = band_energies(audio, bars)
    assert np.isfinite(e).all()
    assert e[1, 0] > e[1, 2] + 20  # a 60 Hz tone is low band
