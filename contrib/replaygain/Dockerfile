# rsgain (https://github.com/complexlogic/rsgain) writes ReplayGain 2.0 tags into the music library.
# See run.sh beside this file and FORK.md ("ReplayGain tags").
FROM ubuntu:26.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends rsgain ffmpeg \
 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["rsgain"]
