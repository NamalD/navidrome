# nowplaylist

Builds a Navidrome playlist from a Last.fm listening history and the time of day: a self-hosted "daylist". It runs
on the desktop (a systemd user timer), not in the Navidrome image, and talks to Navidrome over the Subsonic API.
Listening data stays on the desktop; nothing goes to an LLM provider.

The backlog (`tracker item list` in the fork) has what comes next: a weekly discovery list, AudioMuse-AI
similarity and an optional local Ollama re-ranker. The research and design behind it are in
`~/code/docs/music-recommendations.md`.

## Commands

- `nowplaylist sync` copies the Last.fm history (`user.getRecentTracks`) into a local SQLite file. The first run
  fetches everything (48,615 plays, 244 pages, took about three minutes); later runs fetch the plays since the
  last finished run, looking two weeks further back for scrobbles that arrive late. It ends by printing Last.fm's
  own total next to the stored count. A run that stops part way is safe to repeat.
- `nowplaylist now` ranks every library song for this moment and replaces the songs of one public playlist,
  renamed for the slot ("Now: Friday evening"). It creates the playlist the first time and remembers its ID; if
  the playlist is deleted, the next run makes a new one. `-n` prints the picks without changing anything, and
  `-at 2026-11-28T08:00` ranks for another moment.

## How songs are picked

Library songs are matched to plays by artist and title, after dropping accents, punctuation, a leading "the",
featured artists and decorations such as "(Remastered 2011)" or "- Live" (the library has no MusicBrainz IDs).
Each song gets five signals, each scaled to 0..1 across the library on a log curve, then weighted
(`score.DefaultWeights`):

| Signal | Weight | What it measures |
| --- | --- | --- |
| Track habit | 0.30 | Plays of this track near this time of day (Gaussian, σ 1.5 h), weekday plays counting half on a weekend and the other way round, with a two-year half-life |
| Artist habit | 0.15 | The same for the artist |
| Track recent | 0.20 | Plays of this track, with a ten-day half-life |
| Artist recent | 0.10 | The same for the artist |
| Similar | 0.25 | Last.fm `track.getSimilar` of the 8 latest distinct tracks and `artist.getSimilar` (counted at half) of the 5 latest artists, weighted by how recent each seed is; answers are cached for 30 days |

Songs played in the last six hours go last. The playlist takes the top 40, with at most 4 by one artist, 3 from
one album and one version of each song.

## Settings

KEY=VALUE lines in any `*.env` file in `~/.config/nowplaylist/` (keep the folder `0700` and secrets `0600`);
environment variables of the same name win.

| Key | Meaning |
| --- | --- |
| `LASTFM_USER` | Last.fm username whose history is read |
| `LASTFM_APIKEY` | Last.fm API key (here, the same one Navidrome uses) |
| `NAVIDROME_URL` | Default `https://music.namal.dev` |
| `NAVIDROME_USER` | Default `nowplaylist`, a non-admin account that owns the playlist |
| `NAVIDROME_PASSWORD` | Or the first line of `~/.config/nowplaylist/navidrome-password` |
| `NOWPLAYLIST_DB` | History file; default `~/.local/share/nowplaylist/history.db` |
| `NOWPLAYLIST_CONFIG_DIR` | Settings folder, instead of `~/.config/nowplaylist` |

## Building, installing, testing

A Go module of its own, so the fork's `go test ./...` leaves it out; CI runs it in a step of its own.
`mise.toml` pins the Go version.

```sh
cd contrib/nowplaylist
make test
make install   # builds ~/.local/bin/nowplaylist, installs and starts the systemd user timer
journalctl --user -u nowplaylist   # what the last runs did
```

The timer runs `sync` then `now` every two hours, and at login for a slot missed while the PC was off. The
tests use fake Last.fm and Subsonic servers; none of them call the real APIs.
