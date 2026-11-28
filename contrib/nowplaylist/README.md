# nowplaylist

Builds Navidrome playlists from a Last.fm listening history and the time of day: a self-hosted "daylist". It runs
on the desktop (a systemd user timer), not in the Navidrome image, and talks to Navidrome over the Subsonic API.
Listening data stays on the desktop; nothing is sent to an LLM provider.

Status: only `sync` exists so far. The backlog (`tracker item list` in the fork) has the rest: time-of-day
playlists, a weekly discovery list, AudioMuse-AI similarity and an optional local Ollama re-ranker. The research
and design behind it are in `~/code/docs/music-recommendations.md`.

## Commands

- `nowplaylist sync` copies the Last.fm history (`user.getRecentTracks`) into a local SQLite file. The first run
  fetches everything (48,615 plays, 244 pages, took about three minutes); later runs fetch the plays since the
  last finished run, looking two weeks further back for scrobbles that arrive late. It ends by printing Last.fm's
  own total next to the stored count. A run that stops part way is safe to repeat.

## Settings

KEY=VALUE lines in any `*.env` file in `~/.config/nowplaylist/` (keep the folder `0700` and secrets `0600`);
environment variables of the same name win.

| Key | Meaning |
| --- | --- |
| `LASTFM_USER` | Last.fm username whose history is read |
| `LASTFM_APIKEY` | Last.fm API key (here, the same one Navidrome uses) |
| `NOWPLAYLIST_DB` | History file; default `~/.local/share/nowplaylist/history.db` |
| `NOWPLAYLIST_CONFIG_DIR` | Settings folder, instead of `~/.config/nowplaylist` |

## Building and testing

A Go module of its own, so the fork's `go test ./...` leaves it out. `mise.toml` pins the Go version.

```sh
cd contrib/nowplaylist
go test ./...
go build -o ~/.local/bin/nowplaylist .
```

The tests use a fake Last.fm server; none of them call the real API.
