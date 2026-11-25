"""Download service for Navidrome's "Add music" page, backed by Antra (github.com/anandprtp/Antra).

Navidrome (Downloader.URL) calls this over HTTP; it has no authentication, so keep it on a private network.

    GET  /health
    GET  /search?q=<text>   albums in the catalog
    GET  /jobs              downloads, newest first
    GET  /jobs/<id>
    POST /jobs              {"url": "https://...", "title": "", "artist": "", "artworkUrl": ""}

Downloads run one at a time through Antra's JSON backend (`python -m antra.json_cli`), which reads its settings
from the environment (OUTPUT_DIR, SPOTIFY_SP_DC, FOLDER_STRUCTURE_TEMPLATE, ...). Jobs are kept in memory.
"""

import json
import os
import queue
import shlex
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PORT = int(os.environ.get("PORT", "8787"))
ANTRA_DIR = os.environ.get("ANTRA_DIR", "/opt/antra")
# The command that runs Antra's JSON backend; tests point it at a fake
ANTRA_CMD = shlex.split(os.environ.get("ANTRA_CMD", "")) or [sys.executable, "-m", "antra.json_cli"]
SEARCH_TIMEOUT = int(os.environ.get("SEARCH_TIMEOUT", "90"))
SEARCH_LIMIT = int(os.environ.get("SEARCH_LIMIT", "20"))
MAX_JOBS = 50

QUEUED, RUNNING, COMPLETED, FAILED = "queued", "running", "completed", "failed"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def valid_url(url):
    if not isinstance(url, str) or any(c.isspace() for c in url):
        return False
    parts = urlsplit(url)
    return parts.scheme == "https" and bool(parts.netloc)


def search(query):
    """Albums matching the query, as Antra's catalog search finds them."""
    cmd = ANTRA_CMD + ["--search-catalog", query, "--search-kind", "album", "--search-limit", str(SEARCH_LIMIT)]
    proc = subprocess.run(cmd, cwd=ANTRA_DIR, capture_output=True, text=True, timeout=SEARCH_TIMEOUT)
    error = ""
    for line in proc.stdout.splitlines():
        message = parse(line)
        if message.get("type") == "catalog_search":
            return [
                {
                    "title": item.get("title") or "",
                    "artist": item.get("artists") or "",
                    "year": item.get("year") or 0,
                    "artworkUrl": item.get("artwork_url") or "",
                    "url": item["url"],
                }
                for item in message.get("data") or []
                if item.get("url")
            ]
        if message.get("type") == "error":
            error = message.get("message") or ""
    raise RuntimeError(error or f"search failed (exit {proc.returncode}): {proc.stderr.strip()[-300:]}")


def parse(line):
    try:
        message = json.loads(line)
    except ValueError:
        return {}
    return message if isinstance(message, dict) else {}


class Jobs:
    def __init__(self):
        self.lock = threading.Lock()
        self.jobs = []  # newest first
        self.pending = queue.Queue()
        threading.Thread(target=self.work, daemon=True).start()

    def list(self):
        with self.lock:
            return [dict(job) for job in self.jobs]

    def get(self, job_id):
        with self.lock:
            return next((dict(job) for job in self.jobs if job["id"] == job_id), None)

    def add(self, request):
        with self.lock:
            # Asking again for something still in the queue returns that download
            for job in self.jobs:
                if job["url"] == request["url"] and job["status"] in (QUEUED, RUNNING):
                    return dict(job), False
            job = {
                "id": uuid.uuid4().hex[:12],
                "url": request["url"],
                "title": str(request.get("title") or ""),
                "artist": str(request.get("artist") or ""),
                "artworkUrl": str(request.get("artworkUrl") or ""),
                "status": QUEUED,
                "tracksTotal": 0,
                "tracksDone": 0,
                "tracksFailed": 0,
                "tracksSkipped": 0,
                "currentTrack": "",
                "error": "",
                "createdAt": now(),
            }
            self.jobs.insert(0, job)
            for old in [j for j in self.jobs if j["status"] in (COMPLETED, FAILED)][MAX_JOBS:]:
                self.jobs.remove(old)
            self.pending.put(job["id"])
            return dict(job), True

    def update(self, job_id, **changes):
        with self.lock:
            for job in self.jobs:
                if job["id"] == job_id:
                    job.update(changes)
                    return dict(job)
        return None

    def work(self):
        while True:
            job_id = self.pending.get()
            try:
                self.run(job_id)
            except Exception as e:  # a broken download must not stop the queue
                self.update(job_id, status=FAILED, error=str(e), currentTrack="", finishedAt=now())

    def run(self, job_id):
        job = self.update(job_id, status=RUNNING)
        proc = subprocess.Popen(
            ANTRA_CMD + ["--", job["url"]],
            cwd=ANTRA_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            text=True,
        )
        summary, last_error = None, ""
        with proc:
            for line in proc.stdout:
                message = parse(line)
                kind = message.get("type")
                if kind == "event":
                    self.on_event(job_id, message.get("name"), message.get("payload") or {})
                elif kind == "playlist_summary":
                    summary = message
                elif kind == "error" or (kind == "log" and message.get("level") == "error"):
                    last_error = message.get("message") or last_error
        code = proc.returncode

        changes = {"currentTrack": "", "finishedAt": now()}
        if summary:
            changes.update(
                tracksTotal=summary.get("total") or 0,
                tracksDone=summary.get("downloaded") or 0,
                tracksFailed=summary.get("failed") or 0,
                tracksSkipped=summary.get("skipped") or 0,
            )
            if not job["title"]:
                changes["title"] = summary.get("title") or ""
            if not job["artworkUrl"]:
                changes["artworkUrl"] = summary.get("artwork_url") or ""
        job = self.update(job_id, **changes)
        added = job["tracksDone"] + job["tracksSkipped"]
        if summary and not summary.get("error") and added > 0:
            self.update(job_id, status=COMPLETED)
        else:
            error = (summary or {}).get("error") or last_error
            if not error:
                error = "no track could be downloaded" if summary else f"Antra exited with code {code}"
            self.update(job_id, status=FAILED, error=error)

    def on_event(self, job_id, name, payload):
        changes = {}
        if payload.get("track_total"):
            changes["tracksTotal"] = payload["track_total"]
        if name == "track_started":
            changes["currentTrack"] = payload.get("track") or ""
        job = self.update(job_id, **changes)
        counter = {"track_completed": "tracksDone", "track_failed": "tracksFailed", "track_skipped": "tracksSkipped"}
        if job and name in counter:
            self.update(job_id, **{counter[name]: job[counter[name]] + 1})


class Handler(BaseHTTPRequestHandler):
    jobs = None

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def fail(self, status, message):
        self.reply(status, {"error": message})

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/health":
            return self.reply(200, {"status": "ok"})
        if url.path == "/search":
            query = (parse_qs(url.query).get("q") or [""])[0].strip()
            if not query:
                return self.fail(400, "missing parameter q")
            try:
                return self.reply(200, search(query))
            except subprocess.TimeoutExpired:
                return self.fail(504, "search timed out")
            except Exception as e:
                return self.fail(502, str(e))
        if url.path == "/jobs":
            return self.reply(200, self.jobs.list())
        if url.path.startswith("/jobs/"):
            job = self.jobs.get(url.path[len("/jobs/"):])
            return self.reply(200, job) if job else self.fail(404, "no such job")
        self.fail(404, "not found")

    def do_POST(self):
        if urlsplit(self.path).path != "/jobs":
            return self.fail(404, "not found")
        try:
            request = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        except ValueError:
            request = None
        if not isinstance(request, dict) or not valid_url(request.get("url")):
            return self.fail(400, "url must be an https link")
        job, created = self.jobs.add(request)
        self.reply(201 if created else 200, job)

    def log_message(self, format, *args):
        # Navidrome polls /jobs while a download runs; only log what changes something
        if self.command != "GET":
            super().log_message(format, *args)


def serve(port=PORT):
    Handler.jobs = Jobs()
    return ThreadingHTTPServer(("0.0.0.0", port), Handler)


if __name__ == "__main__":
    server = serve()
    print(f"antra-downloader listening on :{server.server_port}", flush=True)
    server.serve_forever()
