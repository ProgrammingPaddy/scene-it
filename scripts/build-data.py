#!/usr/bin/env python3
"""
Build movies.json from the IMDb non-commercial datasets.

The datasets are plain gzip'd TSV files, downloaded once (no API, no key):

    https://datasets.imdbws.com/title.basics.tsv.gz    (~230 MB)
    https://datasets.imdbws.com/title.ratings.tsv.gz   (~9 MB)
    https://datasets.imdbws.com/title.crew.tsv.gz      (~85 MB)   optional, for directors
    https://datasets.imdbws.com/title.principals.tsv.gz (~785 MB) optional, for cast
    https://datasets.imdbws.com/name.basics.tsv.gz     (~310 MB)  optional, for names
    https://datasets.imdbws.com/title.episode.tsv.gz   (~55 MB)   shows only, for season and episode counts

Usage:

    python scripts/build-data.py --source <folder> [--kind movie|show] [--top N]

Writes data/movies.json or data/shows.json (feature films, or TV series and
mini-series, ordered by vote count).

Output is a compact JSON document the page loads once:

    {
      "generated": "2026-09-29",
      "count": 10000,
      "fields": ["id", "title", "year", "runtime", "genres", "rating", "votes", "directors"],
      "movies": [[111161, "The Shawshank Redemption", 1994, 142, "Drama", 9.3, 2900000, "Frank Darabont"], ...]
    }

"id" is the numeric part of the IMDb tconst ("tt0111161" -> 111161).
Movies are ordered by vote count, most voted first, which is the closest
thing the data has to "how likely is it that someone has seen this".
"""

import argparse
import csv
import gzip
import json
import os
import sys
from datetime import date

csv.field_size_limit(1 << 20)

# IMDb writes missing values as a literal backslash-N.
NULL = "\\" + "N"


def open_tsv(path):
    handle = gzip.open(path, "rt", encoding="utf-8", newline="")
    return csv.reader(handle, delimiter="\t", quoting=csv.QUOTE_NONE)


def log(message):
    print(message, file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", required=True, help="folder containing the IMDb .tsv.gz files")
    parser.add_argument("--kind", choices=["movie", "show"], default="movie", help="feature films, or TV series and mini-series (default movie)")
    parser.add_argument("--top", type=int, default=None, help="how many titles to keep (default 10000 movies, 5000 shows)")
    parser.add_argument("--min-votes", type=int, default=1000, help="ignore titles below this many votes while scanning")
    parser.add_argument("--out", default=None, help="output file (default data/movies.json or data/shows.json)")
    parser.add_argument("--cast", type=int, default=4, help="how many top-billed actors to keep (default 4)")
    parser.add_argument("--no-people", action="store_true", help="skip directors and cast (title.crew, title.principals, name.basics)")
    args = parser.parse_args()

    root = os.path.join(os.path.dirname(__file__), "..")
    title_types = {"movie": {"movie"}, "show": {"tvSeries", "tvMiniSeries"}}[args.kind]
    top = args.top or {"movie": 10000, "show": 5000}[args.kind]
    out_path = args.out or os.path.join(root, "data", f"{args.kind}s.json")

    src = lambda name: os.path.join(args.source, name)

    # 1. Ratings: tconst -> (rating, votes), only titles with enough votes.
    log("Reading ratings...")
    ratings = {}
    reader = open_tsv(src("title.ratings.tsv.gz"))
    next(reader)  # header
    for tconst, rating, votes in reader:
        votes = int(votes)
        if votes >= args.min_votes:
            ratings[tconst] = (float(rating), votes)
    log(f"  {len(ratings):,} titles with at least {args.min_votes:,} votes")

    # 2. Basics: keep the wanted title types only.
    log("Scanning title.basics (this is the slow part)...")
    movies = []
    reader = open_tsv(src("title.basics.tsv.gz"))
    header = next(reader)
    col = {name: index for index, name in enumerate(header)}
    for row in reader:
        tconst = row[col["tconst"]]
        if tconst not in ratings:
            continue
        if row[col["titleType"]] not in title_types or row[col["isAdult"]] != "0":
            continue
        year = row[col["startYear"]]
        if not year.isdigit():
            continue
        end_year = row[col["endYear"]]
        runtime = row[col["runtimeMinutes"]]
        genres = row[col["genres"]]
        rating, votes = ratings[tconst]
        movies.append({
            "tconst": tconst,
            "title": row[col["primaryTitle"]],
            "original": row[col["originalTitle"]],
            "year": int(year),
            "endYear": int(end_year) if end_year.isdigit() else None,
            "runtime": int(runtime) if runtime.isdigit() else None,
            "genres": "" if genres == NULL else genres,
            "rating": rating,
            "votes": votes,
        })
    log(f"  {len(movies):,} {args.kind}s found")

    movies.sort(key=lambda m: (-m["votes"], m["title"]))
    movies = movies[:top]
    log(f"  keeping the top {len(movies):,} by votes (least popular kept: {movies[-1]['votes']:,} votes)")

    # 2b. Shows: season and episode counts from title.episode.
    seasons = {m["tconst"]: None for m in movies}
    episodes = {m["tconst"]: None for m in movies}
    if args.kind == "show":
        log("Reading episodes...")
        wanted = set(seasons)
        reader = open_tsv(src("title.episode.tsv.gz"))
        next(reader)
        for _episode, parent, season, _number in reader:
            if parent in wanted:
                episodes[parent] = (episodes[parent] or 0) + 1
                if season.isdigit() and int(season) > (seasons[parent] or 0):
                    seasons[parent] = int(season)
        log(f"  episode counts found for {sum(1 for v in episodes.values() if v):,} shows")

    # 3. Directors and cast (optional).
    directors = {m["tconst"]: [] for m in movies}
    cast = {m["tconst"]: [] for m in movies}
    if not args.no_people:
        wanted = set(directors)
        needed_names = set()

        log("Reading crew...")
        reader = open_tsv(src("title.crew.tsv.gz"))
        next(reader)
        for tconst, dirs, _writers in reader:
            if tconst in wanted and dirs != NULL:
                ids = dirs.split(",")[:3]
                directors[tconst] = ids
                needed_names.update(ids)

        log("Reading principals (the other slow part)...")
        reader = open_tsv(src("title.principals.tsv.gz"))
        header = next(reader)
        pcol = {name: index for index, name in enumerate(header)}
        billed = {}
        for row in reader:
            tconst = row[pcol["tconst"]]
            if tconst in wanted and row[pcol["category"]] in ("actor", "actress"):
                billed.setdefault(tconst, []).append((int(row[pcol["ordering"]]), row[pcol["nconst"]]))
        for tconst, people in billed.items():
            people.sort()
            # Series credit the same actor once per season, so keep the first mention only.
            unique = list(dict.fromkeys(nconst for _order, nconst in people))
            cast[tconst] = unique[: args.cast]
            needed_names.update(cast[tconst])

        if args.kind == "show":
            # title.crew lists episode directors for a series, which says little
            # about the show itself, so shows carry cast only.
            directors = {tconst: [] for tconst in directors}
        log(f"  {len(needed_names):,} names to resolve")

        log("Reading names...")
        names = {}
        reader = open_tsv(src("name.basics.tsv.gz"))
        next(reader)
        for row in reader:
            if row[0] in needed_names:
                names[row[0]] = row[1]
        for table in (directors, cast):
            for tconst, ids in table.items():
                table[tconst] = [names[n] for n in ids if n in names]

    # 4. Write.
    fields = ["id", "title", "year", "runtime", "genres", "rating", "votes", "directors", "original", "cast", "endYear", "seasons", "episodes"]
    rows = []
    for m in movies:
        original = m["original"] if m["original"] != m["title"] else ""
        rows.append([
            int(m["tconst"][2:]),
            m["title"],
            m["year"],
            m["runtime"],
            m["genres"],
            m["rating"],
            m["votes"],
            ", ".join(directors[m["tconst"]]),
            original,
            ", ".join(cast[m["tconst"]]),
            m["endYear"],
            seasons[m["tconst"]],
            episodes[m["tconst"]],
        ])

    document = {
        "generated": date.today().isoformat(),
        "source": "IMDb datasets (datasets.imdbws.com), non-commercial use",
        "kind": args.kind,
        "count": len(rows),
        "fields": fields,
        "movies": rows,
    }

    out = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, separators=(",", ":"))
    log(f"Wrote {out} ({os.path.getsize(out) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
