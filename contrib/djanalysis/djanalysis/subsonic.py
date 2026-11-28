"""The parts of the Subsonic API djanalysis needs: list songs and download originals. Logs in with token auth as
the same account nowplaylist uses (settings in ~/.config/nowplaylist)."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import urllib.parse
import urllib.request
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("NOWPLAYLIST_CONFIG_DIR", Path.home() / ".config" / "nowplaylist"))


def load_settings() -> dict:
    """KEY=VALUE lines from every *.env file in the config folder, the password from navidrome-password, and the
    environment on top."""
    vals: dict[str, str] = {}
    for f in sorted(CONFIG_DIR.glob("*.env")):
        for line in f.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip("'\"")
    pw = CONFIG_DIR / "navidrome-password"
    if pw.exists():
        vals.setdefault("NAVIDROME_PASSWORD", pw.read_text().splitlines()[0] if pw.read_text() else "")
    for k in ("NAVIDROME_URL", "NAVIDROME_USER", "NAVIDROME_PASSWORD"):
        if k in os.environ:
            vals[k] = os.environ[k]
    vals.setdefault("NAVIDROME_URL", "https://music.namal.dev")
    vals.setdefault("NAVIDROME_USER", "nowplaylist")
    return vals


class SubsonicError(Exception):
    pass


class Client:
    def __init__(self, base_url: str, user: str, password: str):
        self.base_url = base_url.rstrip("/")
        self.user = user
        self.password = password

    @classmethod
    def from_settings(cls) -> "Client":
        s = load_settings()
        if not s.get("NAVIDROME_PASSWORD"):
            raise SubsonicError(f"no Navidrome password in {CONFIG_DIR}/navidrome-password or NAVIDROME_PASSWORD")
        return cls(s["NAVIDROME_URL"], s["NAVIDROME_USER"], s["NAVIDROME_PASSWORD"])

    def _params(self, extra: dict) -> bytes:
        salt = secrets.token_hex(8)
        token = hashlib.md5((self.password + salt).encode()).hexdigest()
        p = {"u": self.user, "t": token, "s": salt, "v": "1.16.1", "c": "djanalysis", "f": "json", **extra}
        return urllib.parse.urlencode(p, doseq=True).encode()

    def call(self, method: str, **params) -> dict:
        req = urllib.request.Request(f"{self.base_url}/rest/{method}", data=self._params(params))
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.load(r)["subsonic-response"]
        if body.get("status") != "ok":
            err = body.get("error", {})
            raise SubsonicError(f"{method}: {err.get('code')} {err.get('message')}")
        return body

    def songs(self) -> list[dict]:
        """Every song in the library; Navidrome treats the query `""` as "match everything"."""
        out, offset, size = [], 0, 500
        while True:
            page = self.call("search3", query='""', artistCount=0, albumCount=0, songCount=size, songOffset=offset)
            songs = page.get("searchResult3", {}).get("song", [])
            out += songs
            if len(songs) < size:
                return out
            offset += size

    def download(self, song_id: str, dest: Path) -> Path:
        """Saves the original file (no transcoding) to dest."""
        req = urllib.request.Request(f"{self.base_url}/rest/download", data=self._params({"id": song_id}))
        with urllib.request.urlopen(req, timeout=300) as r:
            if r.headers.get_content_type() in ("application/json", "text/xml", "application/xml"):
                raise SubsonicError(f"download {song_id}: {r.read(500).decode(errors='replace')}")
            with open(dest, "wb") as f:
                shutil.copyfileobj(r, f)
        return dest


class Uploader:
    """Uploads analyses to Navidrome's /api/dj/upload, authenticated with DJ_UPLOAD_KEY (Navidrome's
    DJ.UploadKey)."""

    def __init__(self, base_url: str, key: str):
        self.base_url = base_url.rstrip("/")
        self.key = key

    @classmethod
    def from_settings(cls) -> "Uploader":
        s = load_settings()
        key = os.environ.get("DJ_UPLOAD_KEY") or s.get("DJ_UPLOAD_KEY")
        if not key:
            raise SubsonicError(f"no DJ_UPLOAD_KEY in {CONFIG_DIR}/*.env or the environment")
        return cls(s["NAVIDROME_URL"], key)

    def _request(self, method: str, path: str, body: bytes | None = None) -> urllib.request.Request:
        req = urllib.request.Request(f"{self.base_url}/api/dj/upload{path}", data=body, method=method)
        req.add_header("Authorization", f"Bearer {self.key}")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        return req

    def checksums(self) -> dict[str, str]:
        with urllib.request.urlopen(self._request("GET", "/"), timeout=60) as r:
            return json.load(r)

    def put(self, song_id: str, body: bytes) -> None:
        with urllib.request.urlopen(self._request("PUT", "/" + urllib.parse.quote(song_id, safe=""), body), timeout=60):
            pass
