# This fork

A personal fork of [navidrome/navidrome](https://github.com/navidrome/navidrome) that runs at `music.namal.dev`.
It adds features to Navidrome itself; they are written the way upstream code is (same structure, tests, lint), so
each could be offered upstream as a pull request.

## Branches

- `main` (default): upstream's latest release tag we have taken, plus our commits. Every push builds and deploys it.
- `master`: mirrors upstream's `master`. Don't commit to it.

Remotes in a checkout: `origin` is this fork, `upstream` is navidrome/navidrome.

## What is added

- **Endless play.** The ∞ button in the player bar. While it is on, the queue is extended when its last track
  starts: 10 songs similar to that track that are not queued yet, topped up with random ones, so playback never
  stops. The setting is per browser. Code: `ui/src/audioplayer/useEndlessPlay.js`.
- **Lyrics sidebar.** The lyrics button in the player bar opens a sidebar that loads lyrics through
  `getLyricsBySongId`, so sidecar files and lyrics plugins show up, not only embedded tags. It is upstream's
  pull request #5733 squashed into one commit while that is still open there; drop our commit when a release
  we take includes it. Code: `ui/src/audioplayer/usePlayerLyrics.jsx` and the `Lyrics*` files beside it.
- **Disk usage.** The activity panel (admins only) shows how full the disk holding each library is: the share
  used and the space left, from `GET /api/storage`. Here the library is a Hetzner Storage Box mounted over SMB.
  Code: `utils/disk`, `server/nativeapi/storage.go` and `ui/src/layout/ActivityPanel.jsx`.
- **Add music.** The "Add Music" page in the sidebar (admins only) searches a streaming catalog for albums, or
  takes a pasted link, and downloads the one picked into the library, showing each download's progress. Navidrome
  does not download anything itself: `Downloader.URL` (`ND_DOWNLOADER_URL`) points at a download service, the page
  talks to it through `/api/downloader`, and the library is scanned when a download finishes. Without the
  setting the page and the endpoints don't exist. Our service is `contrib/antra-downloader`: a small HTTP server
  around [Antra](https://github.com/anandprtp/Antra), run as a second container (see below).
  Code: `core/downloader`, `server/nativeapi/downloader.go` and `ui/src/downloader`.

- **Omnibar.** The search box in the top bar (press `/` to focus it) searches artists, albums, songs and
  playlists at once and lists the best matches of each in one dropdown. Picking a song plays it; anything else
  opens its page; "See all" opens that list filtered by the query. The matches in each group come best first: a list
  request that filters by the search field (`title`, `name`, `lyrics`) and asks for no order is answered by the
  ranked search instead of the filter. Code: `ui/src/layout/Omnibar.jsx` and
  `useOmniSearch.js` beside it.
- **Search by lyrics.** The omnibar also lists the songs whose lyrics contain the words typed, with the line that
  matched, and the song list takes a `lyrics` filter ("See all" uses it). It searches the lyrics in each song's
  tags or, for a song without any, those fetched for it in the background: once at startup and then on
  `LyricsFetchSchedule` (`ND_LYRICSFETCHSCHEDULE`, default `@every 1h`, `0` turns it off), every song without
  lyrics in its tags goes through the other `LyricsPriority` sources (the `nd-lyrics` plugin here, one song a
  second), and the result is kept in `media_file_fetched_lyrics`. A song is fetched again when it changes, and
  one with nothing found (or a failed fetch, as plugins report "no lyrics" as an error) a week later. The index
  is the FTS5 table `media_file_lyrics_fts`, kept current by triggers on both tables. Both are created at startup
  rather than by a migration, because goose stops the server when the database is ahead of a migration it has
  not applied, as it would be for any upstream migration written before ours and released after. Code:
  `db/lyrics_search.go`, `core/lyrics/fetcher.go`, `persistence/fetched_lyrics_repository.go`,
  `persistence/sql_search_lyrics.go` and `ui/src/layout/lyricsMatch.js`.

- **Gapless playback.** Songs in the web player follow each other with no gap: the first sample of a track
  plays right after the last sample of the one before, as on a CD, for albums such as live sets and mixes. The
  player asks the server for every song as FLAC (FLAC files as they are, the rest converted to it), splits each
  download into frames, decodes it a piece at a time and schedules the pieces on one Web Audio clock; the next
  track in the queue is downloaded ahead and starts on the sample the current one ends. It works behind the music
  player library's own `<audio>` element, which it stands in for, so the library and the rest of the UI don't
  change; internet radio still plays through the element. Repeat-one loops gaplessly too. Two tracks at different
  sample rates still have a short gap between them (the audio clock has to restart at the new rate). A browser
  whose Web Audio can't decode FLAC (checked once with a tiny file) keeps the normal player. On by
  default, with a switch on the Personal page (per browser). ReplayGain is applied by the player in either case,
  and its default is now "album", which keeps the quiet and loud tracks of an album as they were mastered. Code:
  `ui/src/audioplayer/gapless` (`engine.js` is the player, `mediaFacade.js` the stand-in element).
- **ReplayGain tags.** `contrib/replaygain` tags the library with ReplayGain values (rsgain in a container, album
  and track gain per album folder, track gain for loose files). On the VPS it runs from cron every night at
  04:30 and skips files already tagged; Navidrome picks the tags up on its next scan.

## Build and deploy

`.github/workflows/fork-deploy.yml` checks the web UI (lint, formatting, tests), runs the Go tests, builds the
Docker image as `ghcr.io/namald/navidrome:<upstream version>-<short sha>` and deploys that tag to the VPS, which
rolls back if Navidrome doesn't answer. To roll back by hand, run the workflow with an older tag. Upstream's own workflows are
disabled in this repository.

## The download service

`contrib/antra-downloader` is not part of the Navidrome image and CI does not build it. On the VPS its
`Dockerfile` and `server.py` are copied to `~/apps/navidrome/antra-downloader/`, and `docker-compose.yml` there
builds and runs it as `antra-downloader` beside Navidrome, with the music folder mounted writable at `/music`
and Antra's settings (the Spotify cookie, the folder template) in `antra-downloader.env`. It has no
authentication and publishes no port; only Navidrome reaches it, at `http://antra-downloader:8787`. After
changing it, or to take a new Antra release (`ANTRA_VERSION` in the Dockerfile):

```sh
scp contrib/antra-downloader/{Dockerfile,server.py} <vps>:apps/navidrome/antra-downloader/
ssh <vps> 'cd ~/apps/navidrome && docker compose up -d --build antra-downloader'
```

Its tests use a fake in place of Antra: `python3 -m unittest discover contrib/antra-downloader`.

## Playlists from listening history

`contrib/nowplaylist` is a separate Go module, not part of the Navidrome image, that runs on the desktop. It
reads the Last.fm history and keeps a public "Now: <day> <time of day>" playlist in Navidrome up to date through the
Subsonic API, as the non-admin user `nowplaylist`, every two hours from a systemd user timer. CI runs its tests;
how it picks songs, and how to build, install and configure it, is in its `README.md`.

## DJ mixing

"Start DJ Mix" in a song's menu (song lists, albums, playlists) plays that song in DJ mode, and the disc button in the
player bar turns DJ mode on or off for whatever is playing. In DJ mode the web player mixes each song into the next,
beatmatched and key-matched, and keeps the queue one song ahead: when the playing song is the last, it asks the
planner for the next and adds it (endless play stands aside); when you queued one yourself, it mixes into that.
Each song still scrobbles as usual. Navidrome stores per-song analysis but never analyses audio:
`contrib/djanalysis` does that on the desktop GPU and uploads it. The table `media_file_dj_analysis` is created
at startup like the lyrics index. `PUT /api/dj/upload/{id}` and `GET /api/dj/upload` take `DJ.UploadKey`
(`ND_DJ_UPLOADKEY`) as a bearer token instead of a login and don't exist without it; `GET /api/dj/analysis/{id}`
serves a song's analysis, minus its embedding, to logged-in users. Code: `db/dj_analysis.go`,
`persistence/dj_analysis_repository.go`, `server/nativeapi/dj.go`.

`GET /api/dj/next?current=<id>&rate=&semitones=&exclude=<ids>&history=<ids>` is the planner (`core/djmix`). It
scores every analysed song the user can see on sound (cosine of Discogs-EffNet embeddings, as a rank), tempo (within
±8% after folding half/double time) and key (Camelot wheel, transposing up to a semitone), picks at random among the
best five, and returns the song with its transition: a phrase-aligned blend of 4–16 bars (at most 32 s) with a bass
swap halfway, an echo-out when tempos are too far apart, or a 12 s fade when either song has no steady beat. Times
are seconds into each song as recorded. Analyses stay in memory and reload every 10 minutes. `next=<id>` plans
the transition into that song instead of choosing one.

The mixer is `ui/src/audioplayer/dj`: `engine.js` has the gapless engine's interface, so the same `<audio>` facade
puts it behind the player. Each song plays on a deck (`deck.js`): its FLAC stream is decoded piece by piece into a
signalsmith-stretch node, which plays it at the planned rate and transposition, then through a trim (levelled to
-14 LUFS from the analysis), a low shelf for the bass swap, a fader and an echo send. `timeline.js` turns a plan into
the automation on both decks. Streams are requested as 44.1 kHz/16-bit FLAC (a transcode profile limit), so the
mixer's context runs at 44.1 kHz and never resamples. signalsmith-stretch is vendored in `dj/vendor/` with upstream
PR #30 applied, because 1.3.2 goes silent on input added in several pieces (backlog #15). Songs without an analysis
still play in DJ mode, one after the other with no mix.

A blend is locked onto the beats in the browser (`warp.js`), since the plan's single detected downbeats are a frame
(20 ms) off and beat_this sits on the off-beat in some drumless intros. Each song gets a straight beat grid through
its beats around the blend, by the phase most beats agree on, and its bars from most downbeats; the next song plays
at the rate that matches the grids, from a bar start onto a bar start. Measured from recordings in Chrome and
Firefox, beats and bars land within 5 ms. A blend whose beats can't be locked (no steady grid, or a stretch the
tracker hears in 3:2) becomes an echo-out instead. The analysis's BPM (`fit_grid`) is the same kind of grid; before
2026-11-28 it counted beat intervals and ran over 1% fast on 171 songs, and `djanalysis regrid` refitted them.

## Taking a new upstream release

```sh
git fetch upstream --tags
git switch main
git merge v<new version>     # resolve conflicts, then run the UI checks in ui/
git push origin main --tags  # the tags tell the build which upstream version it is
```

## Working on the web UI

```sh
cd ui
npm ci
npm run lint && npm run check-formatting && npm test
```

`npm start` serves the UI on port 4533 and expects a Navidrome backend on port 4633.
