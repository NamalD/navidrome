"""Analyses one audio file for the DJ mixer.

Beats and downbeats come from beat_this (GPU), key from Essentia's KeyExtractor and libkeyfinder (agreement is the
confidence), loudness from pyloudnorm (EBU R128), per-bar band energy and phrase boundaries from the downbeats, and
a sound-similarity embedding from Essentia's Discogs-EffNet model (CPU).
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import music

SCHEMA_VERSION = 1
SR = 44100
HOME = Path(os.environ.get("DJANALYSIS_HOME", Path.home() / "hdd" / "djanalysis"))
KEYFINDER = HOME / "keyfinder-pcm"
EFFNET = HOME / "models" / "discogs-effnet-bs64-1.pb"
BANDS = [(20, 150), (150, 2500), (2500, 16000)]  # low, mid, high


def decode(path: Path, sr: int = SR) -> np.ndarray:
    """Decodes any format ffmpeg reads into mono float32 at sr."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32).copy()


@dataclass
class Models:
    """Loaded once and reused across tracks."""

    beats: object
    effnet: object

    @classmethod
    def load(cls, device: str = "cuda") -> "Models":
        from beat_this.inference import Audio2Beats
        import essentia.standard as es

        return cls(
            beats=Audio2Beats(checkpoint_path="final0", device=device, dbn=False),
            effnet=es.TensorflowPredictEffnetDiscogs(graphFilename=str(EFFNET), output="PartitionedCall:1"),
        )


def essentia_key(audio: np.ndarray) -> dict:
    import essentia.standard as es

    key, scale, strength = es.KeyExtractor(profileType="edma", sampleRate=SR)(audio)
    return {"pitch_class": music.PITCH_CLASSES[key], "minor": scale == "minor", "strength": float(strength)}


def keyfinder_key(audio: np.ndarray) -> dict | None:
    out = subprocess.run([str(KEYFINDER), str(SR)], input=audio.astype("<f4").tobytes(), check=True,
                         capture_output=True).stdout.decode().split()
    if out == ["silence"]:
        return None
    return {"pitch_class": int(out[0]), "minor": out[1] == "minor"}


def choose_key(ess: dict, kf: dict | None) -> dict:
    """Essentia's EDM profile is the answer; libkeyfinder only sets the confidence: "high" when both agree,
    "medium" when they are relative major and minor (same Camelot number, so they mix the same), else "low"."""
    a = (ess["pitch_class"], ess["minor"])
    if kf is not None and (kf["pitch_class"], kf["minor"]) == a:
        confidence = "high"
    elif kf is not None and music.same_camelot_number(a, (kf["pitch_class"], kf["minor"])):
        confidence = "medium"
    else:
        confidence = "low"
    return {
        "name": music.key_name(*a),
        "camelot": music.camelot(*a),
        "pitch_class": a[0],
        "minor": a[1],
        "confidence": confidence,
        "essentia": {**ess, "name": music.key_name(ess["pitch_class"], ess["minor"])},
        "keyfinder": None if kf is None else {**kf, "name": music.key_name(kf["pitch_class"], kf["minor"])},
    }


def band_energies(audio: np.ndarray, bars: list[tuple[float, float]]) -> np.ndarray:
    """RMS energy in dB per bar for each of BANDS, shape (bars, len(BANDS) + 1); the last column is the full band."""
    out = np.zeros((len(bars), len(BANDS) + 1))
    for i, (a, b) in enumerate(bars):
        seg = audio[int(a * SR):int(b * SR)]
        if len(seg) < 256:
            out[i] = -120
            continue
        spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
        freqs = np.fft.rfftfreq(len(seg), 1 / SR)
        for j, (lo, hi) in enumerate(BANDS):
            out[i, j] = 10 * np.log10(spec[(freqs >= lo) & (freqs < hi)].mean() + 1e-12)
        out[i, -1] = 10 * np.log10(np.mean(seg ** 2) + 1e-12)
    return out


def loudness(audio: np.ndarray) -> float | None:
    import pyloudnorm

    try:
        value = float(pyloudnorm.Meter(SR).integrated_loudness(audio.astype(np.float64)))
    except ValueError:  # shorter than one gating block
        return None
    return None if not np.isfinite(value) else round(value, 2)


def embedding(models: Models, path: Path) -> list[float]:
    """Mean Discogs-EffNet embedding over the track (1280 numbers), scaled to unit length for cosine similarity."""
    frames = np.asarray(models.effnet(decode(path, 16000)))
    v = frames.mean(axis=0)
    v = v / (np.linalg.norm(v) + 1e-12)
    return [round(float(x), 5) for x in v]


def analyse(models: Models, path: Path) -> dict:
    audio = decode(path)
    duration = len(audio) / SR
    beats, downbeats = models.beats(audio, SR)
    beats, downbeats = np.asarray(beats, dtype=float), np.asarray(downbeats, dtype=float)
    grid = music.fit_grid(beats)
    # Beatless: under one beat every four seconds, or beats that don't sit on a steady grid even over a few bars
    # (ambient, rubato). Those get long crossfades, never a beatmatched blend.
    beatless = grid is None or len(beats) < duration / 4 or grid["local_jitter"] > 0.025 or len(downbeats) < 4
    bars = music.bars_from_downbeats(downbeats, duration) if not beatless else []
    energy = band_energies(audio, bars) if bars else np.zeros((0, len(BANDS) + 1))
    phrases = music.phrase_boundaries(energy) if len(bars) else []

    return {
        "schema": SCHEMA_VERSION,
        "duration": round(duration, 3),
        "bpm": grid["bpm"] if grid else 0.0,
        # first_beat, local_jitter (s off a straight line over 32 beats), drift (s off one line for the whole
        # track), octave_switch_share (how often the tracker hopped between half and double time).
        "grid": grid,
        "beatless": bool(beatless),
        "beats": [round(float(b), 4) for b in beats],
        "downbeats": [round(float(d), 4) for d in downbeats],
        "key": choose_key(essentia_key(audio), keyfinder_key(audio)),
        "loudness_lufs": loudness(audio),
        "bar_energy_db": [[round(float(x), 2) for x in row] for row in energy],
        "bar_energy_bands": ["low", "mid", "high", "full"],
        # Bar indices (into downbeats) where a section starts.
        "phrases": phrases,
        "embedding": embedding(models, path),
    }
