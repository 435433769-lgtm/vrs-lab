"""Local server for VRS Lab: static files, live update API, auto rebuild.

Besides serving the static prototype, this process watches the official Valve
repository for a new monthly snapshot. When one appears it runs
``scripts/build_data.py`` and the open page hot-swaps to the new bundle.

Endpoints:
    GET  /api/meta   current build metadata + updater status (JSON)
    POST /api/check  ask the updater to check the official repository now

The static prototype keeps working without these endpoints, it just stops
auto-updating (for example on Gitee Pages).
"""

from __future__ import annotations

import argparse
import functools
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
        LOG.write_text((proc.stdout or "") + "\n" + (proc.stderr or ""), encoding="utf-8")
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


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:  # noqa: D102
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: D102
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/meta":
            meta = read_meta() or {}
            with STATE_LOCK:
                meta.update(STATE)
            meta["now"] = utc_now()
            self.send_json(meta)
            return
        if path in ("/", "/index.html"):
            body = versioned_index()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: D102
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/check":
            if STATE["building"] or STATE["checking"]:
                self.send_json({"ok": True, "started": False, "reason": "already running"})
                return
            threading.Thread(target=check_once, daemon=True).start()
            self.send_json({"ok": True, "started": True})
            return
        self.send_error(404)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument(
        "--interval",
        type=int,
        default=1800,
        help="seconds between official repository checks (default 1800)",
    )
    parser.add_argument("--no-watch", action="store_true", help="serve only, never rebuild")
    args = parser.parse_args()

    if not args.no_watch:
        threading.Thread(target=updater_loop, args=(args.interval,), daemon=True).start()

    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print(f"Serving {ROOT} on http://{args.bind}:{args.port} (no-store)")
        if not args.no_watch:
            print(f"Watching Valve's repository every {args.interval}s; POST /api/check to check now.")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
