#!/usr/bin/env python3
"""Serve panel/www for development, passing /api/* to a running t6-paneld.

    python3 panel/tools/dev-server.py [--port 8902] [--backend http://127.0.0.1:9600]
                                      [--set language=zh --set theme=dark]

Then open http://127.0.0.1:8902/ in a 390 x 780 window. Files are served
fresh on every request, as t6-paneld does. --set overrides a top-level field
of /api/panel, to try a language or theme without changing settings.json.
"""
import argparse
import http.server
import json
import urllib.error
import urllib.request
from pathlib import Path

UI = Path(__file__).resolve().parent.parent / "www"


class Handler(http.server.SimpleHTTPRequestHandler):
    backend = ""
    overrides = {}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(UI), **kwargs)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(self.backend + self.path, data=body, method=self.command)
        if self.headers.get("Content-Type"):
            req.add_header("Content-Type", self.headers["Content-Type"])
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                status, headers, data = res.status, res.headers, res.read()
        except urllib.error.HTTPError as e:
            status, headers, data = e.code, e.headers, e.read()
        except OSError:
            self.send_error(502, "backend not answering")
            return
        if self.path.startswith("/api/panel") and status == 200 and self.overrides:
            data = json.dumps({**json.loads(data), **self.overrides}).encode()
        self.send_response(status)
        self.send_header("Content-Type", headers.get("Content-Type", "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/"):
            self.proxy()
        else:
            super().do_GET()

    do_PUT = do_POST = do_DELETE = proxy


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8902)
    ap.add_argument("--backend", default="http://127.0.0.1:9600")
    ap.add_argument("--set", action="append", default=[], metavar="FIELD=VALUE")
    a = ap.parse_args()
    Handler.backend = a.backend.rstrip("/")
    Handler.overrides = dict(kv.split("=", 1) for kv in a.set)
    Handler.extensions_map[".js"] = "application/javascript"
    print(f"panel UI on http://127.0.0.1:{a.port}/ (api → {Handler.backend})")
    http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
