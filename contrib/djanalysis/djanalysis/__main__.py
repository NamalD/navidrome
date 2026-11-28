"""djanalysis: analyse the Navidrome library for the DJ mixer.

    djanalysis run [--limit N] [--id SONG_ID ...] [--force]
    djanalysis upload

Downloads each song that has no current analysis, analyses it on the GPU, saves the result as
<cache>/<song id>.json and deletes the download. A song is analysed again when its file size or the analysis
schema changes. Stops (exit code 75) when a game starts using the GPU, so a timer can try again later.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .analyse import HOME, SCHEMA_VERSION
from .subsonic import Client, Uploader

CACHE = HOME / "cache"
TMP = HOME / "tmp"
EX_TEMPFAIL = 75

# Processes that use the GPU but are not games.
GPU_OK = ("kwin_wayland", "Xwayland", "plasmashell", "firefox", "chrome", "python", "ollama", "mpv", "vlc")


def game_running() -> str | None:
    """A game process using the GPU, if any: a Windows .exe under Proton, or anything from steamapps."""
    try:
        out = subprocess.run(["nvidia-smi", "--query-compute-apps=process_name", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=20).stdout
        gfx = subprocess.run(["nvidia-smi"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    for line in (out + "\n" + gfx).splitlines():
        low = line.lower()
        if ".exe" in low or "steamapps" in low or "wine" in low:
            return line.strip()
    return None


def is_current(path: Path, song: dict) -> bool:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return False
    return data.get("schema") == SCHEMA_VERSION and data.get("source", {}).get("size") == song.get("size")


def run(args: argparse.Namespace) -> int:
    CACHE.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    client = Client.from_settings()
    songs = client.songs()
    if args.id:
        songs = [s for s in songs if s["id"] in set(args.id)]
    todo = [s for s in songs if args.force or not is_current(CACHE / f"{s['id']}.json", s)]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(songs)} songs, {len(todo)} to analyse", flush=True)
    if not todo:
        return 0
    if game := game_running():
        print(f"a game is using the GPU ({game}); not starting", flush=True)
        return EX_TEMPFAIL

    from .analyse import Models, analyse

    models = Models.load()
    failed = 0
    start = time.time()
    for n, song in enumerate(todo, 1):
        if n % 10 == 0 and (game := game_running()):
            print(f"a game started using the GPU ({game}); stopping after {n - 1}", flush=True)
            return EX_TEMPFAIL
        label = f"{song.get('artist')} - {song.get('title')}"
        with tempfile.TemporaryDirectory(dir=TMP) as tmp:
            try:
                f = client.download(song["id"], Path(tmp) / f"track.{song.get('suffix', 'bin')}")
                result = analyse(models, f)
            except Exception as e:  # one bad file must not stop the run
                failed += 1
                print(f"[{n}/{len(todo)}] FAILED {label}: {e}", flush=True)
                continue
        result["source"] = {k: song.get(k) for k in ("id", "size", "suffix", "artist", "title", "album", "duration")}
        out = CACHE / f"{song['id']}.json"
        tmp_out = out.with_suffix(".json.tmp")
        # allow_nan=False: NaN is not JSON, and Navidrome would refuse the upload.
        tmp_out.write_text(json.dumps(result, separators=(",", ":"), allow_nan=False))
        tmp_out.replace(out)
        k = result["key"]
        print(f"[{n}/{len(todo)}] {label}: {result['bpm']:.1f} BPM{' (beatless)' if result['beatless'] else ''}, "
              f"{k['name']} {k['camelot']} ({k['confidence']})", flush=True)
    print(f"done in {time.time() - start:.0f}s, {failed} failed", flush=True)
    return 1 if failed else 0


def upload(_: argparse.Namespace) -> int:
    """Sends every cached analysis whose checksum differs from the one Navidrome holds."""
    import hashlib
    import urllib.error

    up = Uploader.from_settings()
    remote = up.checksums()
    sent = failed = 0
    files = sorted(CACHE.glob("*.json"))
    for f in files:
        body = f.read_bytes()
        if remote.get(f.stem) == hashlib.sha256(body).hexdigest():
            continue
        try:
            up.put(f.stem, body)
            sent += 1
        except urllib.error.HTTPError as e:
            # 404: the song has gone from the library since it was analysed.
            failed += 1
            print(f"upload {f.stem}: HTTP {e.code} {e.read(200).decode(errors='replace')}", flush=True)
    print(f"{len(files)} analyses, {sent} uploaded, {len(files) - sent - failed} unchanged, {failed} failed")
    return 1 if failed else 0


def main() -> int:
    p = argparse.ArgumentParser(prog="djanalysis")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="analyse songs that have no current analysis")
    r.add_argument("--limit", type=int, default=0)
    r.add_argument("--id", action="append", default=[])
    r.add_argument("--force", action="store_true")
    sub.add_parser("upload", help="send new and changed analyses to Navidrome")
    args = p.parse_args()
    return {"run": run, "upload": upload}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
