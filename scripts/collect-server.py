#!/usr/bin/env python3
"""
Tiny local receiver for the browser-side IMDb collector.

The browser (a real one, signed in to nothing, just viewing imdb.com) runs
scripts/collect-imdb.js on an IMDb page. That script reads each title page's
structured data (the plot outline and poster IMDb publishes in JSON-LD) and
POSTs batches here. Each batch is appended to scripts/.cache/imdb-plots.jsonl
in the same {"key": "tt…", "value": [plot, poster]} form the other caches use.

    python scripts/collect-server.py [--port 8792]

GET /todo returns the ids still missing from the cache, so the browser script
can resume. Stop with Ctrl-C when the cache is complete.
"""

import argparse
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

root = os.path.join(os.path.dirname(__file__), "..")
CACHE = os.path.join(root, "scripts", ".cache", "imdb-plots.jsonl")
MOVIES = os.path.join(root, "movies.json")

lock = threading.Lock()


def load_ids():
    with open(MOVIES, encoding="utf-8") as handle:
        document = json.load(handle)
    index = document["fields"].index("id")
    return [f"tt{row[index]:07d}" for row in document["movies"]]


def cached_ids():
    if not os.path.exists(CACHE):
        return set()
    with open(CACHE, encoding="utf-8") as handle:
        return {json.loads(line)["key"] for line in handle if line.strip()}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/todo"):
            done = cached_ids()
            todo = [i for i in load_ids() if i not in done]
            self._json(200, {"todo": todo, "done": len(done)})
        else:
            self._json(200, {"done": len(cached_ids())})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        rows = json.loads(self.rfile.read(length).decode("utf-8"))
        with lock:
            os.makedirs(os.path.dirname(CACHE), exist_ok=True)
            with open(CACHE, "a", encoding="utf-8") as handle:
                for row in rows:
                    handle.write(json.dumps({"key": row["key"], "value": row["value"]}, ensure_ascii=False) + "\n")
            total = len(cached_ids())
        self._json(200, {"saved": len(rows), "done": total})

    def log_message(self, *_):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8792)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Listening on http://127.0.0.1:{args.port}  ({len(cached_ids())} titles cached)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
