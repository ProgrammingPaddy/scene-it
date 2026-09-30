#!/usr/bin/env python3
"""
Fetch each movie's overview and poster from The Movie Database (TMDB).

TMDB is where Letterboxd, Plex and Trakt get their synopses: short,
official-style and free of spoilers. Lookup is by IMDb id, so matching is
exact. It needs a free API key (themoviedb.org, Settings, API), used once,
here, on your machine; put it in scripts/.cache/tmdb-key.txt (git-ignored)
or pass --key.

    python scripts/fetch-tmdb.py [--movies data/movies.json | data/shows.json] [--threads 8]

Results are cached in scripts/.cache/tmdb.jsonl as
{"key": "tt…", "value": [overview, poster path]} and picked up by
scripts/fetch-details.py. About five minutes for 10,000 movies.
"""

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

root = os.path.join(os.path.dirname(__file__), "..")
CACHE_DIR = os.path.join(root, "scripts", ".cache")


def log(message):
    print(message, file=sys.stderr, flush=True)


class Cache:
    def __init__(self, path):
        self.path = path
        self.data = {}
        self.lock = threading.Lock()
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                for line in handle:
                    if line.strip():
                        row = json.loads(line)
                        self.data[row["key"]] = row["value"]

    def put(self, key, value):
        with self.lock:
            self.data[key] = value
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"key": key, "value": value}, ensure_ascii=False) + "\n")


def lookup(imdb_id, key, tries=6):
    url = f"https://api.themoviedb.org/3/find/{imdb_id}?external_source=imdb_id&api_key={key}"
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "SceneIt/1.0 (personal project)"})
            with urllib.request.urlopen(request, timeout=60) as response:
                data = json.loads(response.read().decode("utf-8"))
            results = (data.get("movie_results") or []) + (data.get("tv_results") or [])
            if not results:
                return ["", ""]
            movie = results[0]
            return [" ".join((movie.get("overview") or "").split()), movie.get("poster_path") or ""]
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return ["", ""]
            if error.code == 401:
                raise SystemExit("TMDB rejected the API key (401).")
            wait = int(error.headers.get("Retry-After") or 2 ** attempt)
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            time.sleep(2 ** attempt)
    log(f"  gave up on {imdb_id}")
    return ["", ""]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--movies", default=os.path.join(root, "data", "movies.json"), help="data/movies.json or data/shows.json")
    parser.add_argument("--key", default=None)
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args()

    key_file = os.path.join(CACHE_DIR, "tmdb-key.txt")
    key = args.key or (open(key_file, encoding="utf-8").read().strip() if os.path.exists(key_file) else "")
    if not key:
        raise SystemExit(f"No TMDB key: pass --key or write it to {key_file}")

    with open(args.movies, encoding="utf-8") as handle:
        document = json.load(handle)
    index = document["fields"].index("id")
    ids = [f"tt{row[index]:07d}" for row in document["movies"]]

    os.makedirs(CACHE_DIR, exist_ok=True)
    cache = Cache(os.path.join(CACHE_DIR, "tmdb.jsonl"))
    todo = [i for i in ids if i not in cache.data]
    log(f"TMDB: {len(ids) - len(todo):,} cached, {len(todo):,} to fetch")

    done = 0
    lock = threading.Lock()

    def task(imdb_id):
        nonlocal done
        cache.put(imdb_id, lookup(imdb_id, key))
        with lock:
            done += 1
            if done % 500 == 0 or done == len(todo):
                log(f"  {done:,}/{len(todo):,}")

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        list(pool.map(task, todo))

    found = sum(1 for i in ids if cache.data.get(i, ["", ""])[0])
    posters = sum(1 for i in ids if cache.data.get(i, ["", ""])[1])
    log(f"Done: {found:,} of {len(ids):,} movies have an overview, {posters:,} a poster")


if __name__ == "__main__":
    main()
