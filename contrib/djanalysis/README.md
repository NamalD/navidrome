# djanalysis

Analyses every Navidrome song for the DJ mixer and uploads the results to Navidrome (`/api/dj/upload`), which
stores them in `media_file_dj_analysis` and serves them to the player at `/api/dj/analysis/{id}`. It runs on the
desktop because it needs the GPU; Navidrome never analyses audio itself. The research behind the choices is in
`~/code/docs/auto-dj-mixing.md`; the backlog items are #10–#14.

## What it measures

Per song, downloaded as the original file through the Subsonic `download` endpoint and deleted afterwards:

| Field | From |
| --- | --- |
| `beats`, `downbeats` (seconds) | [beat_this](https://github.com/CPJKU/beat_this) `final0`, on the GPU |
| `bpm`, `grid` | A straight-line fit through the beats, folding intervals the tracker heard in half or double time. `grid.local_jitter` is how far beats sit off a line over 32 beats (seconds); `grid.drift` the same for one line over the whole song |
| `beatless` | Under one beat per 4 s, `local_jitter` over 25 ms, or under 4 downbeats. Such songs only get long crossfades |
| `key` | Essentia `KeyExtractor` (EDM profile) is the answer; libkeyfinder sets `confidence`: `high` if it agrees, `medium` if it gives the relative major/minor, else `low`. Also `camelot` |
| `loudness_lufs` | EBU R128 integrated loudness (pyloudnorm), mono |
| `bar_energy_db` | Per bar: energy in low (<150 Hz), mid, high (>2.5 kHz) and full band, dB |
| `phrases` | Bar indices where a section starts: peaks in bar-to-bar change of the band energies, at least 8 bars apart, snapped to 4-bar steps |
| `embedding` | Mean Discogs-EffNet embedding (1280 numbers, unit length) for sound similarity; the player never gets it |
| `source` | Song ID, file size, artist, title, album, duration |

A song is analysed again when its file size or `SCHEMA_VERSION` changes. allin1 (learned section labels) was left
out: its 2023 release needs a CUDA source build of natten and a 2018 madmom.

Known weak spots: tempo can come out at half or double the felt tempo (the planner treats those as equal), and
beat_this finds beats in some classical and ambient pieces that a DJ wouldn't call beats.

## Setup

Everything heavy (7 GB venv, models, cache, downloads) lives in `~/hdd/djanalysis`, because `/home` is nearly full.

```sh
cd contrib/djanalysis
make setup     # venv (Python 3.14, torch cu128), libkeyfinder helper, Essentia model
make test
make install   # also installs and starts the systemd user timer
```

Settings come from `~/.config/nowplaylist/`, shared with nowplaylist: the Navidrome account
(`navidrome-password`, user `nowplaylist`) and `DJ_UPLOAD_KEY` in `dj.env`, which must equal Navidrome's
`DJ.UploadKey` (`ND_DJ_UPLOADKEY` on the VPS).

## Running

```sh
~/hdd/djanalysis/venv/bin/python -m djanalysis run [--limit N] [--id SONG_ID] [--force]
~/hdd/djanalysis/venv/bin/python -m djanalysis upload
journalctl --user -u djanalysis
```

The timer runs both every three hours. `run` won't start, and stops within ten songs, while a game is using the
GPU (a Proton `.exe` or anything under `steamapps` in `nvidia-smi`), exiting 75; the next timer run carries on.
The whole library (about 650 songs) took about 5 s a song, mostly CPU.
