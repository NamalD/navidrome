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
