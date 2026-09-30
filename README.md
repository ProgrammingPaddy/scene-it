# Scene It

A static web page for marking which popular movies and TV shows you have
seen, rating them, and exporting the result. Part of piddicus.com.

## What it does

- Shows one title at a time (poster, year, runtime, director or cast,
  genres, IMDb rating, synopsis). Answers: seen, not seen, want to watch,
  skip. Seen titles can be rated 0.5 to 10.
- Covers the 10,000 most-voted feature films and the 5,000 most-voted TV
  series on IMDb. A switch selects movies, shows, or both.
- A list view shows every title in a table with the same controls.
- Exports the answers as: Piddicus `watched.txt`, Letterboxd CSV, IMDb CSV
  (ratings or watchlist layout, usable with Trakt and Simkl), plain CSV,
  JSON, plain text, Markdown. Each export can be limited to seen titles,
  want-to-watch titles, or everything.
- Imports JSON backups, Letterboxd exports, IMDb CSV exports, and Piddicus
  lists.
- Answers are stored in the browser's localStorage. Nothing is sent to a
  server.

## Files

```
index.html, app.js, style.css   The page
data/movies.json                Movie list
data/shows.json                 Show list
data/movies/, data/shows/       Synopsis and poster URL per title, 200 per file
project.json, preview.svg       Card metadata and illustration for the piddicus.com menu
scripts/build-data.py           Builds the lists from the IMDb dataset files
scripts/fetch-tmdb.py           Fetches synopses and poster URLs from TMDB
scripts/fetch-details.py        Writes the data/movies and data/shows files
scripts/collect-*.js|py         Optional: reads plot outlines from IMDb pages in a browser
```

## Keyboard

`→` seen, `←` not seen, `↑` want to watch, `↓` skip, `1`-`9`/`0` seen with
rating, `Z` undo, `M`/`T`/`B` movies/shows/both, `/` search, `?` help.

## Rebuilding the data

1. Download from https://datasets.imdbws.com/: `title.basics`,
   `title.ratings`, `title.crew`, `title.principals`, `title.episode`,
   `name.basics` (all `.tsv.gz`) into one folder.
2. `python scripts/build-data.py --source <folder> --kind movie` and again
   with `--kind show`.
3. Put a TMDB API key in `scripts/.cache/tmdb-key.txt`, then
   `python scripts/fetch-tmdb.py --movies data/movies.json` and again with
   `data/shows.json`.
4. `python scripts/fetch-details.py --movies data/movies.json` and again
   with `data/shows.json`.

Results are cached in `scripts/.cache/` (git-ignored). No script requests
pages from imdb.com.

## Deploying

Push to GitHub, then in the piddicus.com checkout run
`npm run sync -- scene-it` and commit. The card preview lives at
`public/previews/scene-it.svg` in the site repo.
