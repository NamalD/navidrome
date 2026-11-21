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

## Build and deploy

`.github/workflows/fork-deploy.yml` checks the web UI (lint, formatting, tests), builds the Docker image as
`ghcr.io/namald/navidrome:<upstream version>-<short sha>` and deploys that tag to the VPS, which rolls back if
Navidrome doesn't answer. To roll back by hand, run the workflow with an older tag. Upstream's own workflows are
disabled in this repository. The workflow does not run the Go tests; add them to it with the first backend change.

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
