# Antra (github.com/anandprtp/Antra) behind the small HTTP service Navidrome's "Add music" page talks to.
FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

ARG ANTRA_VERSION=v2.0.0
RUN git clone --depth 1 --branch ${ANTRA_VERSION} https://github.com/anandprtp/Antra /opt/antra \
    && pip install --no-cache-dir -r /opt/antra/requirements-runtime.txt

COPY server.py /opt/antra-downloader/server.py

# Antra keeps its caches under $HOME and saves music to OUTPUT_DIR; mount a volume on each
ENV HOME=/data \
    OUTPUT_DIR=/music \
    PYTHONUNBUFFERED=1
USER 1000:1000
EXPOSE 8787
CMD ["python", "/opt/antra-downloader/server.py"]
