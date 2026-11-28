#!/usr/bin/env bash
# Writes ReplayGain 2.0 tags (rsgain) into the music library, so players can level loudness.
# Only tags change; the audio is left as it is. Files that already have tags are skipped, so this is cheap to
# run on a schedule and picks up albums added since the last run. Navidrome's scheduled scan then reads the tags.
#
# Each folder is treated as one album (rsgain's "easy" mode), except LOOSE_DIRS and files at the top of the
# library: those hold unrelated tracks, so they get track gain only.
#
# Usage: run.sh [library path]   (default /mnt/storagebox/music). Needs the replaygain:local image (Dockerfile).
set -euo pipefail

LIBRARY=${1:-/mnt/storagebox/music}
LOOSE_DIRS=(chopshop)

rsgain() {
  docker run --rm --user "$(id -u):$(id -g)" -v "$LIBRARY:/music" replaygain:local "$@"
}

is_loose() {
  local name=$1 d
  for d in "${LOOSE_DIRS[@]}"; do [[ $name == "$d" ]] && return 0; done
  return 1
}

is_audio() {
  [[ ${1,,} =~ \.(flac|m4a|mp3|wav|ogg|opus|aiff?|wma)$ ]]
}

echo "== $(date -Is) ReplayGain run on $LIBRARY"

loose=()
while IFS= read -r -d '' path; do
  name=${path#"$LIBRARY"/}
  if [[ -f $path ]]; then
    is_audio "$name" && loose+=("/music/$name")
  elif is_loose "$name"; then
    while IFS= read -r -d '' f; do
      is_audio "$f" && loose+=("/music/${f#"$LIBRARY"/}")
    done \
      < <(find "$path" -type f -print0)
  else
    rsgain easy --skip-existing --multithread=2 "/music/$name" || echo "!! rsgain failed on $name"
  fi
done < <(find "$LIBRARY" -mindepth 1 -maxdepth 1 ! -name '.*' -print0 | sort -z)

if ((${#loose[@]})); then
  # Custom mode without -a: track gain only. Clipping protection for positive gains matches easy mode's
  # default preset (some of these are quiet takes that would otherwise get +28 dB).
  rsgain custom --tagmode=i --skip-existing --clip-mode=p "${loose[@]}"
fi

echo "== $(date -Is) done"
