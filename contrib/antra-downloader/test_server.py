"""Tests for server.py, with a fake in place of Antra. Run: python3 -m unittest discover contrib/antra-downloader"""

import json
import sys
import tempfile
import textwrap
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from threading import Thread

import server

# Stands in for `python -m antra.json_cli`: prints what Antra prints for a search or a two-track album
FAKE_ANTRA = textwrap.dedent(
    """
    import json, sys
    def emit(**message): print(json.dumps(message), flush=True)
    def event(name, **payload): emit(type="event", name=name, payload=payload)
    args = sys.argv[1:]
    if "--search-catalog" in args:
        query = args[args.index("--search-catalog") + 1]
        if query == "boom":
            emit(type="error", message="catalog unavailable")
            sys.exit(1)
        emit(type="log", level="info", message="searching")
        emit(type="catalog_search", data=[
            {"kind": "album", "title": "Getting Killed", "artists": "Geese", "year": None,
             "artwork_url": "https://img.example/1.jpg", "url": "https://open.spotify.com/album/1"},
            {"kind": "album", "title": "No link", "artists": "Nobody", "url": ""},
        ])
        sys.exit(0)
    assert args[0] == "--", args
    url = args[1]
    if url.endswith("/crash"):
        print("not json")
        sys.exit(3)
    if url.endswith("/nothing"):
        emit(type="log", level="error", message="no source has this album")
        emit(type="playlist_summary", url=url, title="", total=2, downloaded=0, failed=2, skipped=0, error=None)
        emit(type="done")
        sys.exit(0)
    event("track_started", track="Trinidad", track_index=1, track_total=2)
    event("track_completed", track="Trinidad", track_index=1, track_total=2)
    event("track_started", track="Cobra", track_index=2, track_total=2)
    event("track_failed", track="Cobra", track_index=2, track_total=2)
    emit(type="playlist_summary", url=url, title="Getting Killed", artwork_url="https://img.example/1.jpg",
         total=2, downloaded=1, failed=1, skipped=0, error=None)
    emit(type="done")
    """
)


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        fake = Path(cls.tmp.name) / "fake_antra.py"
        fake.write_text(FAKE_ANTRA)
        server.ANTRA_CMD = [sys.executable, str(fake)]
        server.ANTRA_DIR = cls.tmp.name
        cls.httpd = server.serve(port=0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_port}"
        Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def call(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data)
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def wait(self, job_id):
        for _ in range(200):
            status, job = self.call(f"/jobs/{job_id}")
            self.assertEqual(status, 200)
            if job["status"] in (server.COMPLETED, server.FAILED):
                return job
            time.sleep(0.05)
        self.fail("download did not finish")

    def test_search(self):
        status, results = self.call("/search?q=getting%20killed")
        self.assertEqual(status, 200)
        self.assertEqual(
            results,
            [
                {
                    "title": "Getting Killed",
                    "artist": "Geese",
                    "year": 0,
                    "artworkUrl": "https://img.example/1.jpg",
                    "url": "https://open.spotify.com/album/1",
                }
            ],
        )

    def test_search_needs_a_query(self):
        self.assertEqual(self.call("/search?q=")[0], 400)

    def test_search_reports_antras_error(self):
        status, body = self.call("/search?q=boom")
        self.assertEqual(status, 502)
        self.assertEqual(body["error"], "catalog unavailable")

    def test_download(self):
        status, job = self.call("/jobs", {"url": "https://open.spotify.com/album/1", "artist": "Geese"})
        self.assertEqual(status, 201)
        self.assertIn(job["status"], (server.QUEUED, server.RUNNING))

        job = self.wait(job["id"])
        self.assertEqual(job["status"], server.COMPLETED)
        self.assertEqual(job["title"], "Getting Killed")
        self.assertEqual(job["artist"], "Geese")
        self.assertEqual((job["tracksTotal"], job["tracksDone"], job["tracksFailed"]), (2, 1, 1))
        self.assertEqual(job["currentTrack"], "")
        self.assertTrue(job["finishedAt"])
        self.assertIn(job["id"], [j["id"] for j in self.call("/jobs")[1]])

    def test_download_that_finds_nothing_fails(self):
        job = self.wait(self.call("/jobs", {"url": "https://open.spotify.com/album/nothing"})[1]["id"])
        self.assertEqual(job["status"], server.FAILED)
        self.assertEqual(job["error"], "no source has this album")
        self.assertEqual(job["tracksFailed"], 2)

    def test_download_that_crashes_fails(self):
        job = self.wait(self.call("/jobs", {"url": "https://open.spotify.com/album/crash"})[1]["id"])
        self.assertEqual(job["status"], server.FAILED)
        self.assertEqual(job["error"], "Antra exited with code 3")

    def test_only_https_links_are_downloaded(self):
        for url in ["", "--config=/etc/passwd", "file:///etc/passwd", "http://example.com/a", "https://a.example/x y", 5]:
            self.assertEqual(self.call("/jobs", {"url": url})[0], 400, url)

    def test_unknown_job(self):
        self.assertEqual(self.call("/jobs/nope")[0], 404)


if __name__ == "__main__":
    unittest.main()
