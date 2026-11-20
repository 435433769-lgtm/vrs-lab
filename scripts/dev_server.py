"""Local server for VRS Lab: static files, live update API, auto rebuild.

Besides serving the static prototype, this process watches the official Valve
repository for a new monthly snapshot. When one appears it runs
``scripts/build_data.py`` and the open page hot-swaps to the new bundle.

Endpoints:
    GET  /api/meta   current build metadata + updater status (JSON)
    POST /api/check  ask the updater to check the official repository now

Only the public front-end files are served. Everything else in the repository
(``.git``, ``scripts/``, ``data/raw/`` …) stays private. The static prototype
keeps working without these endpoints, it just stops auto-updating.
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import build_data  # noqa: E402  (needs SCRIPTS on sys.path)

ASSETS = ("styles.css", "data.js", "app.js")
META = ROOT / "data" / "meta.json"
LOG = ROOT / "data" / "update.log"

# Exact whitelist: path -> (file on disk, content type). No directory listings
# and no way to reach anything outside this map.
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/data.js": ("data.js", "application/javascript; charset=utf-8"),
    "/data/meta.json": ("data/meta.json", "application/json; charset=utf-8"),
    "/favicon.ico": ("favicon.ico", "image/x-icon"),
}

CHECK_COOLDOWN = 60  # seconds between manual POST /api/check calls per client
CHECK_REQUEST_LOCK = threading.Lock()
CHECK_REQUESTS: dict[str, float] = {}

STATE_LOCK = threading.Lock()
CHECK_LOCK = threading.Lock()
STATE = {
    "checking": False,
    "building": False,
    "lastCheck": None,
    "lastError": None,
    "remoteLatest": None,
    "lastBuildAt": None,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_meta() -> dict | None:
    try:
        return json.loads(META.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None


def remote_latest() -> str | None:
    """Newest snapshot date published by Valve right now."""
    dates: list[str] = []
    for year in build_data.list_years():
        dates.extend(build_data.list_snapshot_dates(year))
    return max(dates) if dates else None


def run_build() -> None:
    with STATE_LOCK:
        STATE["building"] = True
        STATE["lastError"] = None
    print("[updater] new snapshot found, rebuilding data.js ...", flush=True)

    try:
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.run(
            [sys.executable, str(SCRIPTS / "build_data.py")],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=3600,
            env=env,
        )
        LOG.parent.mkdir(parents=True, exist_ok=True)
        build_data.atomic_write(
            LOG, (proc.stdout or "") + "\n" + (proc.stderr or "")
        )
        if proc.returncode != 0:
            raise RuntimeError(f"build_data.py exited with {proc.returncode}")

        meta = read_meta() or {}
        with STATE_LOCK:
            STATE["lastBuildAt"] = meta.get("builtAt")
        print(f"[updater] rebuilt {meta.get('latestDate')} ({meta.get('teamCount')} teams)", flush=True)
    except Exception as exc:  # noqa: BLE001 - keep serving the old bundle
        with STATE_LOCK:
            STATE["lastError"] = f"{type(exc).__name__}: {exc}"
        print(f"[updater] rebuild failed: {exc}", flush=True)
    finally:
        with STATE_LOCK:
            STATE["building"] = False


def check_once() -> None:
    """Check the official repo and rebuild only when a newer snapshot exists."""
    if not CHECK_LOCK.acquire(blocking=False):
        return
    try:
        with STATE_LOCK:
            STATE["checking"] = True
            STATE["lastCheck"] = utc_now()
        try:
            remote = remote_latest()
            with STATE_LOCK:
                STATE["remoteLatest"] = remote
                STATE["lastError"] = None

            meta = read_meta()
            local = meta.get("latestDate") if meta else None
            need_build = (
                not meta
                or not (ROOT / "data.js").is_file()
                or (remote is not None and (local is None or remote > local))
            )
            if need_build:
                run_build()
            else:
                print(f"[updater] up to date at {local}", flush=True)
        except Exception as exc:  # noqa: BLE001 - network failures are expected
            with STATE_LOCK:
                STATE["lastError"] = f"{type(exc).__name__}: {exc}"
            print(f"[updater] check failed: {exc}", flush=True)
    finally:
        with STATE_LOCK:
            STATE["checking"] = False
        CHECK_LOCK.release()


def updater_loop(interval: int) -> None:
    time.sleep(3)
    while True:
        check_once()
        with STATE_LOCK:
            failed = bool(STATE["lastError"])
        # A transient network error should not wait a full interval.
        time.sleep(300 if failed else max(60, interval))


def versioned_index() -> bytes:
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    for asset in ASSETS:
        path = ROOT / asset
        stamp = int(path.stat().st_mtime) if path.is_file() else 0
        html = re.sub(
            rf'(?P<attr>(?:href|src)="){re.escape(asset)}"',
            rf'\g<attr>{asset}?v={stamp}"',
            html,
        )
    return html.encode("utf-8")


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "VRSLab"
    sys_version = ""

    def request_path(self) -> str:
        return urllib.parse.unquote(urllib.parse.urlparse(self.path).path)

    def send_body(
        self,
        body: bytes,
        content_type: str,
        cache_control: str,
        status: int = 200,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(
        self,
        payload: dict,
        status: int = 200,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_body(
            body,
            "application/json; charset=utf-8",
            "no-store",
            status=status,
            extra_headers=extra_headers,
        )

    def serve_static(self, path: str) -> None:
        name, content_type = STATIC[path]
        if name == "index.html":
            body = versioned_index()
            cache = "no-cache"
        else:
            try:
                body = (ROOT / name).read_bytes()
            except OSError:
                self.send_json({"error": "not found"}, status=404)
                return
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if name == "data/meta.json":
                cache = "no-cache"
            elif "v" in query:
                cache = "public, max-age=31536000, immutable"
            else:
                cache = "no-cache"
        self.send_body(body, content_type, cache)

    def do_GET(self) -> None:  # noqa: D102
        path = self.request_path()
        if path == "/api/meta":
            meta = read_meta() or {}
            with STATE_LOCK:
                meta.update(STATE)
            meta["now"] = utc_now()
            self.send_json(meta)
            return
        if path in STATIC:
            self.serve_static(path)
            return
        self.send_json({"error": "not found"}, status=404)

    def do_HEAD(self) -> None:  # noqa: D102
        path = self.request_path()
        if path == "/api/meta":
            self.send_json({"ok": True})
            return
        if path in STATIC:
            self.serve_static(path)
            return
        self.send_json({"error": "not found"}, status=404)

    def do_POST(self) -> None:  # noqa: D102
        path = self.request_path()
        if path != "/api/check":
            self.send_json({"error": "not found"}, status=404)
            return

        # Nginx sets X-Real-IP; fall back to the socket address for local use.
        client = self.headers.get("X-Real-IP") or self.client_address[0]
        now = time.monotonic()
        with CHECK_REQUEST_LOCK:
            elapsed = now - CHECK_REQUESTS.get(client, 0.0)
            if elapsed < CHECK_COOLDOWN:
                retry_after = max(1, int(CHECK_COOLDOWN - elapsed) + 1)
                self.send_json(
                    {"ok": False, "started": False, "reason": "rate limited"},
                    status=429,
                    extra_headers={"Retry-After": str(retry_after)},
                )
                return
            CHECK_REQUESTS[client] = now
            if len(CHECK_REQUESTS) > 1000:
                cutoff = now - CHECK_COOLDOWN
                for ip, stamp in list(CHECK_REQUESTS.items()):
                    if stamp < cutoff:
                        del CHECK_REQUESTS[ip]

        with STATE_LOCK:
            busy = STATE["building"] or STATE["checking"]
        if busy:
            self.send_json({"ok": True, "started": False, "reason": "already running"})
            return

        threading.Thread(target=check_once, daemon=True).start()
        self.send_json({"ok": True, "started": True})

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument(
        "--interval",
        type=int,
        default=3600,
        help="seconds between official repository checks (default 3600)",
    )
    parser.add_argument("--no-watch", action="store_true", help="serve only, never rebuild")
    args = parser.parse_args()

    if not args.no_watch:
        threading.Thread(target=updater_loop, args=(args.interval,), daemon=True).start()

    with http.server.ThreadingHTTPServer((args.bind, args.port), Handler) as httpd:
        print(f"Serving {ROOT} on http://{args.bind}:{args.port}")
        if not args.no_watch:
            print(f"Watching Valve's repository every {args.interval}s; POST /api/check to check now.")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
