#!/usr/bin/env python3
"""
Fetch a poster and a short synopsis for every movie in movies.json and write
them as chunked JSON files under details/.

This runs once, on your machine. The page never calls an API: it loads the
chunk for the movie on screen (200 movies per file) and shows the poster
straight from the image host.

Sources, all free and keyless:

  1. IMDb's own plot outline and poster, read from each title page's
     structured data. Title pages only load in a real browser, so this part
     is collected there: run scripts/collect-server.py, open an imdb.com
     title page, paste scripts/collect-imdb.js into the console. Results
     land in scripts/.cache/imdb-plots.jsonl and this script prefers them.
  2. TMDB's overview and poster (scripts/fetch-tmdb.py; needs a free key,
     used once). The same non-spoiler kind of text, complete coverage.
  3. Last resort for a synopsis: Wikipedia's extracts API (Wikidata maps
     each IMDb id to its article first). No requests go to IMDb itself.

Every answer is cached in scripts/.cache/*.jsonl, so a rerun after a network
hiccup picks up where it stopped.

Usage:

    python scripts/fetch-details.py [--movies data/movies.json | data/shows.json] [--chunk 200]

Output: data/movies/<n>.json (or data/shows/<n>.json), where n = floor((rank - 1) / chunk),
each an object of "<imdb id number>": [synopsis, poster url].
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = "SceneIt/1.0 (personal project on piddicus.com; contact via github.com/ProgrammingPaddy) python-urllib"
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

MAX_CHARS = 600
POSTER_WIDTH = 300
TMDB_IMAGES = "https://image.tmdb.org/t/p/w342"


def log(message):
    print(message, file=sys.stderr, flush=True)


def get_json(url, data=None, headers=None, tries=6):
    for attempt in range(tries):
        try:
            body = urllib.parse.urlencode(data).encode() if data else None
            request = urllib.request.Request(url, data=body, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            retry_after = error.headers.get("Retry-After") if error.headers else None
            wait = int(retry_after) if retry_after and retry_after.isdigit() else max(10, 10 * 2 ** attempt)
            log(f"  HTTP {error.code}, retry in {wait}s")
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            wait = 2 ** attempt
            log(f"  retry in {wait}s: {error}")
            time.sleep(wait)
    raise RuntimeError(f"gave up on {url[:120]}")


class Cache:
    """Append-only JSON lines: one {"key": ..., "value": ...} per line. Thread-safe."""

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


def tconst(number):
    return f"tt{int(number):07d}"


def run_threaded(items, work, cache, threads, label):
    """Run work(item) -> value for every item not yet cached, a few at a time."""
    todo = [item for item in items if item not in cache.data]
    log(f"{label}: {len(items) - len(todo):,} cached, {len(todo):,} to fetch")
    done = 0
    lock = threading.Lock()

    def task(item):
        nonlocal done
        value = work(item)
        cache.put(item, value)
        with lock:
            done += 1
            if done % 250 == 0 or done == len(todo):
                log(f"  {done:,}/{len(todo):,}")
        time.sleep(0.1)

    with ThreadPoolExecutor(max_workers=threads) as pool:
        list(pool.map(task, todo))


# 1. IMDb poster ----------------------------------------------------------------

def resize_poster(url):
    """..._V1_.jpg -> ..._V1_UX300_.jpg asks IMDb's image host for a 300px-wide copy."""
    return re.sub(r"\._V1_[^.]*\.", f"._V1_UX{POSTER_WIDTH}_.", url) if url else ""


def imdb_poster(imdb_id):
    """The poster IMDb shows in its search box (fallback when the title page was not collected)."""
    data = get_json(f"https://v3.sg.media-imdb.com/suggestion/x/{imdb_id}.json", headers={"User-Agent": BROWSER_UA})
    for hit in (data or {}).get("d", []):
        if hit.get("id") == imdb_id:
            return hit.get("i", {}).get("imageUrl", "")
    return ""


# 2. Wikidata: IMDb id -> Wikipedia title --------------------------------------

def map_titles(ids, cache, batch=1000, pause=61):
    """The query service sometimes limits anonymous clients to one request a
    minute, so ask for a lot of ids per query and wait between queries."""
    todo = [i for i in ids if i not in cache.data]
    log(f"Wikidata: {len(ids) - len(todo):,} cached, {len(todo):,} to look up")

    for start in range(0, len(todo), batch):
        if start:
            time.sleep(pause)
        chunk = todo[start:start + batch]
        values = " ".join(f'"{i}"' for i in chunk)
        query = f"""SELECT ?imdb ?article WHERE {{
  VALUES ?imdb {{ {values} }}
  ?item wdt:P345 ?imdb .
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
}}"""
        rows = get_json("https://query.wikidata.org/sparql", {"format": "json", "query": query})["results"]["bindings"]
        found = {}
        for row in rows:
            article = row["article"]["value"].split("/wiki/", 1)[1]
            found.setdefault(row["imdb"]["value"], urllib.parse.unquote(article).replace("_", " "))
        for i in chunk:
            cache.put(i, found.get(i, ""))
        log(f"  {min(start + batch, len(todo)):,}/{len(todo):,} ({len(found)} matched in this batch)")

    return {i: cache.data.get(i, "") for i in ids}


# 3. Wikipedia summary -----------------------------------------------------------

LEAD_SENTENCE = re.compile(r"\bis an? (\d{4} )?[^.]*\b(film|movie|documentary|anime)\b", re.I)
CREDITS_SENTENCE = re.compile(r"^(It|The film|The movie|Th\w+ film)\b[^.]*\b(stars|starring|features|cast|directed|produced|written|based on)\b", re.I)
TRAILING_CREDITS = re.compile(r"\b(cast (includes|features|consists)|stars|starring|also features|supporting cast|ensemble cast)\b", re.I)


def trim(text):
    """Keep the plot part of the lead: drop the 'X is a 2014 film directed by…'
    sentence and any 'It stars…' credits sentences when a plot line follows,
    then cut to MAX_CHARS at a sentence end."""
    text = " ".join(text.split())
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z\"'(])", text)

    if len(sentences) > 1 and LEAD_SENTENCE.search(sentences[0]) and len(" ".join(sentences[1:])) >= 60:
        sentences = sentences[1:]

    # A credits sentence is a list of names ("It stars A, B, C and D."); one
    # that goes on to describe a character ("The film stars X as a thief who…")
    # is plot and stays.
    while len(sentences) > 1 and CREDITS_SENTENCE.search(sentences[0]) and sentences[0].count(",") >= 3 and len(" ".join(sentences[1:])) >= 60:
        sentences = sentences[1:]

    # The same kind of list at the end ("The cast includes A, B, C and D.") goes too.
    while len(sentences) > 1 and TRAILING_CREDITS.search(sentences[-1]) and sentences[-1].count(",") >= 3:
        sentences = sentences[:-1]

    out = ""
    for sentence in sentences:
        if out and len(out) + len(sentence) + 1 > MAX_CHARS:
            break
        out = f"{out} {sentence}".strip()

    return out if len(out) <= MAX_CHARS else out[:MAX_CHARS].rsplit(" ", 1)[0] + "…"


def fetch_summaries(titles, cache, batch=20, pause=3):
    """Wikipedia title -> [lead paragraph, page image], 20 titles per request.

    Anonymous clients get about ten of these requests before a short
    throttle, so the pace is one request every few seconds and a 429 is
    waited out; roughly 300 titles a minute overall."""
    todo = [t for t in titles if t and t not in cache.data]
    log(f"Wikipedia summaries: {len(titles) - len(todo):,} cached, {len(todo):,} to fetch")

    for start in range(0, len(todo), batch):
        chunk = todo[start:start + batch]
        params = {
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "prop": "extracts|pageimages",
            "exintro": "1",
            "explaintext": "1",
            "exsentences": "6",
            "exlimit": str(batch),
            "piprop": "thumbnail",
            "pithumbsize": "300",
            "pilimit": str(batch),
            "pilicense": "any",
            "redirects": "1",
            "titles": "|".join(chunk),
        }
        data = get_json("https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(params)) or {}
        query = data.get("query", {})

        # Redirects and normalisation change the title that comes back; map it back.
        aliases = {}
        for entry in query.get("normalized", []) + query.get("redirects", []):
            aliases[entry["to"]] = entry["from"]

        results = {}
        for page in query.get("pages", []):
            title = page.get("title", "")
            original = aliases.get(title, title)
            while original in aliases and aliases[original] != original:
                original = aliases[original]
            # Cached untrimmed, so the trimming rules can change without refetching.
            value = [" ".join(page.get("extract", "").split()), page.get("thumbnail", {}).get("source", "").split("?")[0]]
            results[original] = value
            results[title] = value

        for t in chunk:
            cache.put(t, results.get(t, ["", ""]))

        done = min(start + batch, len(todo))
        if done % 400 < batch or done == len(todo):
            log(f"  {done:,}/{len(todo):,}")
        time.sleep(pause)


# Main ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root = os.path.join(os.path.dirname(__file__), "..")
    parser.add_argument("--movies", default=os.path.join(root, "data", "movies.json"), help="data/movies.json or data/shows.json")
    parser.add_argument("--out", default=None, help="output folder (default: data/movies or data/shows, matching the input)")
    parser.add_argument("--cache", default=os.path.join(root, "scripts", ".cache"))
    parser.add_argument("--chunk", type=int, default=200)
    parser.add_argument("--threads", type=int, default=2, help="parallel poster lookups (IMDb throttles bursts)")
    args = parser.parse_args()

    with open(args.movies, encoding="utf-8") as handle:
        document = json.load(handle)
    index = {name: i for i, name in enumerate(document["fields"])}
    movies = document["movies"]
    ids = [tconst(row[index["id"]]) for row in movies]

    if not args.out:
        args.out = os.path.splitext(args.movies)[0]

    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)

    # IMDb's own plot outline and poster, collected in a browser by
    # scripts/collect-imdb.js through scripts/collect-server.py. Preferred
    # whenever present; Wikipedia only fills the gaps.
    plots = Cache(os.path.join(args.cache, "imdb-plots.jsonl"))
    log(f"IMDb plot outlines: {sum(1 for i in ids if plots.data.get(i, ['', ''])[0]):,} of {len(ids):,} collected")

    # TMDB overviews and posters (scripts/fetch-tmdb.py), the second choice.
    tmdb = Cache(os.path.join(args.cache, "tmdb.jsonl"))
    log(f"TMDB overviews: {sum(1 for i in ids if tmdb.data.get(i, ['', ''])[0]):,} of {len(ids):,} fetched")

    def has_text(i):
        return bool(plots.data.get(i, ["", ""])[0] or tmdb.data.get(i, ["", ""])[0])

    def has_image(i):
        return bool(plots.data.get(i, ["", ""])[1] or tmdb.data.get(i, ["", ""])[1])

    # Posters already collected from IMDb's search endpoint are used, but no
    # new IMDb requests are made: anything without a poster falls back to
    # Wikipedia's page image or the placeholder.
    posters = Cache(os.path.join(args.cache, "imdb-posters.jsonl"))

    missing_plot = [i for i in ids if not has_text(i)]
    titles = map_titles(missing_plot, Cache(os.path.join(args.cache, "wikidata.jsonl"))) if missing_plot else {}

    summaries = Cache(os.path.join(args.cache, "wikipedia-summaries.jsonl"))
    fetch_summaries(list(dict.fromkeys(t for t in titles.values() if t)), summaries)

    chunks = {}
    with_text = with_image = from_imdb = from_tmdb = 0
    for position, row in enumerate(movies):
        movie_id = row[index["id"]]
        imdb_id = tconst(movie_id)
        plot, plot_image = plots.data.get(imdb_id, ["", ""])
        overview, tmdb_poster = tmdb.data.get(imdb_id, ["", ""])
        title = titles.get(imdb_id, "")
        raw, wiki_image = summaries.data.get(title, ["", ""]) if title else ["", ""]
        synopsis = plot or overview or trim(raw)
        from_imdb += bool(plot)
        from_tmdb += bool(not plot and overview)
        image = (
            resize_poster(plot_image or posters.data.get(imdb_id, ""))
            or (f"{TMDB_IMAGES}{tmdb_poster}" if tmdb_poster else "")
            or wiki_image
        )
        with_text += bool(synopsis)
        with_image += bool(image)
        chunks.setdefault(position // args.chunk, {})[str(movie_id)] = [synopsis, image]

    for number, data in chunks.items():
        with open(os.path.join(args.out, f"{number}.json"), "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))

    total = sum(os.path.getsize(os.path.join(args.out, f)) for f in os.listdir(args.out))
    log(f"Wrote {len(chunks)} files to {os.path.abspath(args.out)} ({total / 1024:.0f} KB total)")
    log(f"  {with_text:,} of {len(movies):,} movies have a synopsis ({from_imdb:,} from IMDb, {from_tmdb:,} from TMDB), {with_image:,} have a poster")


if __name__ == "__main__":
    main()
