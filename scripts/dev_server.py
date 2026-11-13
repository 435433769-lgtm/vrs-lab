"""Static dev server with caching disabled.

Python's http.server lets the browser reuse cached scripts, which hides edits.
This wrapper sends no-store headers and rewrites asset URLs in index.html with a
per-file mtime query so edits always load fresh.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import pathlib
import re
import urllib.parse


ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ("styles.css", "data.js", "app.js")


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


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:  # noqa: D102
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: D102
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            body = versioned_index()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()

    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print(f"Serving {ROOT} on http://{args.bind}:{args.port} (no-store)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
