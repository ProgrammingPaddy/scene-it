/**
 * Scene It: flick through thousands of popular movies and TV shows, mark
 * each one seen or not seen (with an optional rating), then export the result.
 *
 * Everything runs in the browser. The title lists are static JSON files built
 * from the IMDb datasets (scripts/build-data.py), one for movies and one for
 * shows; synopses and posters sit in chunked files loaded on demand
 * (scripts/fetch-details.py). Nothing is fetched from an API. Progress lives
 * in localStorage so a reload picks up where you were.
 *
 * The Movies / TV shows / Both switch decides which list the deck, the table,
 * the progress bar and every export work from. Answers are kept by IMDb id,
 * which both kinds share, so switching never loses anything.
 */

const KINDS = {
    movie: { file: "data/movies.json", details: "data/movies", label: "movie", plural: "movies", tag: "Movie", imdbType: "Movie" },
    show: { file: "data/shows.json", details: "data/shows", label: "show", plural: "shows", tag: "Series", imdbType: "TV Series" },
};
const KIND_ORDER = ["show", "movie"];

const MARKS_KEY = "scene-it-marks";
const PREFS_KEY = "scene-it-prefs";

/** The Piddicus Watch List page reads this key and shows the list in it. */
const WATCH_LIST_OVERRIDE_KEY = "watch-list-override";
const WATCH_LIST_PAGE = "../watch-list/";

const SEEN = "seen";
const UNSEEN = "unseen";
const WANT = "want";
const SKIP = "skip";
const STATUSES = [SEEN, UNSEEN, WANT, SKIP];

/** Which answers each export scope takes. */
const SCOPES = {
    seen: [SEEN],
    want: [WANT],
    decided: [SEEN, UNSEEN, WANT],
    all: STATUSES,
};

const DETAILS_CHUNK = 200;
const PAGE_SIZE = 120;
const SWIPE_DISTANCE = 96;

/* State ------------------------------------------------------------------- */

/** kind -> decoded array once loaded; kind -> promise while loading. */
const datasets = { movie: null, show: null };
const loading = { movie: null, show: null };

/** Every loaded title by IMDb id number, across kinds. */
const byId = new Map();

/** The titles the current Movies / TV shows / Both switch covers. */
let pool = [];

/** id -> { s: SEEN | UNSEEN | SKIP, r: rating or null, t: epoch ms } */
const marks = new Map();

/** Undo stack for the deck: { id, prev } where prev is the earlier mark or null. */
const history = [];

/** After an undo, show that title next even though the queue would not. */
let focusId = null;

/**
 * A rating chosen on the current card but not saved yet. Touch sets it by
 * tapping or sliding on the bars; it is saved with the next "seen" (swipe
 * right, the Seen button, or the key). A mouse click on the bars still
 * saves in one go.
 */
let pendingRating = null;

const prefs = {
    view: "deck",
    kind: "movie",
    order: "popular",
    decade: "",
    genre: "",
    minRating: 0,
    status: "all",
    subset: "seen",
    format: "piddicus",
    seed: 1,
};

let filtered = [];
let listRows = [];
let listShown = 0;
let searchQuery = "";

/* Elements ---------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const el = {
    loading: $("loading"),
    app: $("app"),
    progressText: $("progress-text"),
    progressFill: $("progress-fill"),
    tabs: $("tabs"),
    kinds: $("kinds"),
    order: $("order"),
    decade: $("decade"),
    genre: $("genre"),
    minRating: $("min-rating"),
    search: $("search"),
    filterCount: $("filter-count"),
    shuffle: $("shuffle"),
    viewDeck: $("view-deck"),
    viewList: $("view-list"),
    viewExport: $("view-export"),
    cardHolder: $("card-holder"),
    actions: $("actions"),
    seenRating: $("seen-rating"),
    undo: $("undo"),
    recent: $("recent"),
    helpButton: $("help-button"),
    help: $("help"),
    helpClose: $("help-close"),
    chips: $("chips"),
    rows: $("rows"),
    sentinel: $("sentinel"),
    listMore: $("list-more"),
    stats: $("stats"),
    formats: $("formats"),
    subset: $("subset"),
    preview: $("preview"),
    copy: $("copy"),
    download: $("download"),
    openWatchList: $("open-watch-list"),
    exportStatus: $("export-status"),
    importFile: $("import-file"),
    importStatus: $("import-status"),
    transferLink: $("transfer-link"),
    transferCode: $("transfer-code"),
    transferInput: $("transfer-input"),
    transferImport: $("transfer-import"),
    transferStatus: $("transfer-status"),
    reset: $("reset"),
};

/* Persistence ------------------------------------------------------------- */

function loadMarks() {
    try {
        const raw = JSON.parse(localStorage.getItem(MARKS_KEY) || "{}");

        for (const [id, value] of Object.entries(raw)) {
            if (Array.isArray(value) && STATUSES.includes(value[0])) {
                marks.set(Number(id), { s: value[0], r: cleanRating(value[1]), t: Number(value[2]) || 0 });
            }
        }
    } catch {
        marks.clear();
    }
}

let saveTimer = 0;

function saveMarks() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        const raw = {};

        for (const [id, mark] of marks) {
            raw[id] = [mark.s, mark.r, mark.t];
        }

        try {
            localStorage.setItem(MARKS_KEY, JSON.stringify(raw));
        } catch (error) {
            console.error("Could not save progress:", error);
        }
    }, 150);
}

function loadPrefs() {
    try {
        Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"));
    } catch {
        /* defaults */
    }

    if (!["movie", "show", "both"].includes(prefs.kind)) {
        prefs.kind = "movie";
    }
}

function savePrefs() {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
        /* private mode, fine */
    }
}

/* Helpers ----------------------------------------------------------------- */

function cleanRating(value) {
    const number = Number.parseFloat(value);

    if (!Number.isFinite(number) || number <= 0) {
        return null;
    }

    return Math.round(Math.min(10, number) * 2) / 2;
}

function tconst(id) {
    return `tt${String(id).padStart(7, "0")}`;
}

function imdbUrl(title) {
    return `https://www.imdb.com/title/${tconst(title.id)}/`;
}

function formatVotes(votes) {
    if (votes >= 1_000_000) {
        return `${(votes / 1_000_000).toFixed(1)}M`;
    }

    return votes >= 1000 ? `${Math.round(votes / 1000)}k` : String(votes);
}

function formatRuntime(minutes) {
    if (!minutes) {
        return "";
    }

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;

    if (!hours) {
        return `${rest}m`;
    }

    return rest ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${hours}h`;
}

/** "1994" for a movie, "2008–2013" or "2008–" for a show. */
function formatYears(title) {
    if (title.kind !== "show" || title.endYear === title.year) {
        return String(title.year);
    }

    return title.endYear ? `${title.year}–${title.endYear}` : `${title.year}–`;
}

function plural(count, word) {
    return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

/** Lowercase, strip accents and punctuation, collapse spaces: for matching imported titles. */
function normalizeTitle(text) {
    return String(text || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/^(the|a|an) /, "")
        .trim();
}

function statusLabel(status) {
    return { [SEEN]: "Seen", [UNSEEN]: "Not seen", [WANT]: "Want to watch", [SKIP]: "Skipped" }[status] || "";
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

/** A small deterministic PRNG so "Random" order survives a reload. */
function seededRandom(seed) {
    let state = seed >>> 0 || 1;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* Data -------------------------------------------------------------------- */

function activeKinds() {
    return prefs.kind === "both" ? ["movie", "show"] : [prefs.kind];
}

/** "movies", "shows" or "titles", for counts. */
function poolNoun() {
    return prefs.kind === "both" ? "title" : KINDS[prefs.kind].label;
}

function decodeTitles(document, kind) {
    const index = Object.fromEntries(document.fields.map((name, i) => [name, i]));
    const get = (row, field) => (index[field] === undefined ? null : row[index[field]]);

    return document.movies.map((row, position) => {
        const title = get(row, "title");
        const original = get(row, "original") || "";
        const directors = get(row, "directors") || "";
        const cast = get(row, "cast") || "";

        return {
            id: get(row, "id"),
            kind,
            title,
            year: get(row, "year"),
            endYear: get(row, "endYear") || null,
            runtime: get(row, "runtime"),
            genres: get(row, "genres") ? get(row, "genres").split(",") : [],
            rating: get(row, "rating"),
            votes: get(row, "votes"),
            directors,
            original,
            cast,
            seasons: get(row, "seasons") || null,
            episodes: get(row, "episodes") || null,
            rank: position + 1,
            search: `${title} ${original} ${directors} ${cast} ${get(row, "year")}`.toLowerCase(),
            key: normalizeTitle(title),
            originalKey: original ? normalizeTitle(original) : "",
        };
    });
}

function loadKind(kind) {
    if (datasets[kind]) {
        return Promise.resolve(datasets[kind]);
    }

    if (!loading[kind]) {
        loading[kind] = fetch(KINDS[kind].file)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`${KINDS[kind].file} responded ${response.status}`);
                }

                return response.json();
            })
            .then((document) => {
                const titles = decodeTitles(document, kind);
                datasets[kind] = titles;

                for (const title of titles) {
                    byId.set(title.id, title);
                }

                indexTitles(titles);
                return titles;
            })
            .catch((error) => {
                loading[kind] = null;
                throw error;
            });
    }

    return loading[kind];
}

async function setKind(kind) {
    prefs.kind = kind;
    savePrefs();

    for (const button of el.kinds.querySelectorAll(".tab")) {
        button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
    }

    try {
        await Promise.all(activeKinds().map(loadKind));
    } catch (error) {
        console.error(error);
        el.filterCount.textContent = "That list could not be loaded.";
        return;
    }

    pool = activeKinds().flatMap((k) => datasets[k]);
    focusId = null;
    fillFilterOptions();
    renderProgress();
    applyFilters();
}

/* Filtering --------------------------------------------------------------- */

function decadeOf(year) {
    return year < 1950 ? "old" : `${Math.floor(year / 10) * 10}`;
}

function applyFilters() {
    const query = searchQuery.trim().toLowerCase();
    const minRating = Number(prefs.minRating) || 0;

    filtered = pool.filter((title) => {
        if (prefs.decade && decadeOf(title.year) !== prefs.decade) {
            return false;
        }

        if (prefs.genre && !title.genres.includes(prefs.genre)) {
            return false;
        }

        if (minRating && title.rating < minRating) {
            return false;
        }

        return !query || title.search.includes(query);
    });

    switch (prefs.order) {
        case "rating":
            filtered.sort((a, b) => b.rating - a.rating || b.votes - a.votes);
            break;
        case "newest":
            filtered.sort((a, b) => b.year - a.year || b.votes - a.votes);
            break;
        case "oldest":
            filtered.sort((a, b) => a.year - b.year || b.votes - a.votes);
            break;
        case "title":
            filtered.sort((a, b) => a.title.localeCompare(b.title) || a.year - b.year);
            break;
        case "random": {
            const random = seededRandom(prefs.seed);
            const keyed = filtered.map((title) => [random(), title]);
            keyed.sort((a, b) => a[0] - b[0]);
            filtered = keyed.map((pair) => pair[1]);
            break;
        }
        default:
            /* "popular": by votes, which compares across movies and shows. */
            filtered.sort((a, b) => b.votes - a.votes);
    }

    el.shuffle.hidden = prefs.order !== "random";
    el.filterCount.textContent = filtered.length === pool.length
        ? plural(pool.length, poolNoun())
        : `${filtered.length.toLocaleString()} of ${plural(pool.length, poolNoun())} match`;

    renderView();
}

/* Marking ----------------------------------------------------------------- */

function setMark(title, status, rating = null, { record = true } = {}) {
    const previous = marks.get(title.id) || null;

    if (record) {
        history.push({ id: title.id, prev: previous ? { ...previous } : null });

        if (history.length > 500) {
            history.shift();
        }
    }

    if (status === null) {
        marks.delete(title.id);
    } else {
        marks.set(title.id, { s: status, r: status === SEEN ? rating : null, t: Date.now() });
    }

    saveMarks();
}

function decide(title, status, rating = null) {
    setMark(title, status, rating);
    focusId = null;
    renderProgress();
    renderRecent();
    renderDeck();
}

function undo() {
    const last = history.pop();

    if (!last) {
        say(el.recent, "Nothing to undo.");
        return;
    }

    if (last.prev) {
        marks.set(last.id, last.prev);
    } else {
        marks.delete(last.id);
    }

    saveMarks();
    focusId = last.id;
    renderProgress();
    renderRecent();
    renderDeck();
    updateListRow(last.id);
}

/* Progress ---------------------------------------------------------------- */

/** Counts over the titles the switch currently covers. */
function counts(titles = pool) {
    const result = { [SEEN]: 0, [UNSEEN]: 0, [WANT]: 0, [SKIP]: 0, rated: 0, ratingSum: 0, total: titles.length };

    for (const title of titles) {
        const mark = marks.get(title.id);

        if (!mark) {
            continue;
        }

        result[mark.s] += 1;

        if (mark.s === SEEN && mark.r !== null) {
            result.rated += 1;
            result.ratingSum += mark.r;
        }
    }

    /* "Want to watch" is an answer too: the title leaves the deck. */
    result.decided = result[SEEN] + result[UNSEEN] + result[WANT];
    return result;
}

function renderProgress() {
    const c = counts();

    el.progressText.innerHTML = "";
    const left = document.createElement("span");
    left.innerHTML = `<strong>${c[SEEN].toLocaleString()}</strong> seen · <strong>${c[UNSEEN].toLocaleString()}</strong> not seen · <strong>${c[WANT].toLocaleString()}</strong> to watch`;
    const right = document.createElement("span");
    right.textContent = `${c.decided.toLocaleString()} of ${c.total.toLocaleString()} decided`;
    el.progressText.append(left, right);
    el.progressFill.style.width = `${Math.min(100, (c.decided / (c.total || 1)) * 100)}%`;
}

/* Details: synopsis and poster, loaded per chunk of DETAILS_CHUNK titles ---- */

const detailChunks = new Map();

function loadChunk(kind, index) {
    const key = `${kind}:${index}`;

    if (!detailChunks.has(key)) {
        detailChunks.set(key, fetch(`${KINDS[kind].details}/${index}.json`)
            .then((response) => (response.ok ? response.json() : {}))
            .catch(() => ({})));
    }

    return detailChunks.get(key);
}

function chunkOf(title) {
    return Math.floor((title.rank - 1) / DETAILS_CHUNK);
}

async function detailsFor(title) {
    const chunk = await loadChunk(title.kind, chunkOf(title));
    const entry = chunk[String(title.id)] || ["", ""];
    return { synopsis: entry[0] || "", image: entry[1] || "" };
}

/* Deck -------------------------------------------------------------------- */

function queueInfo() {
    let first = null;
    let firstSkipped = null;

    for (const title of filtered) {
        const mark = marks.get(title.id);

        if (!mark) {
            first ??= title;
            break;
        } else if (mark.s === SKIP) {
            firstSkipped ??= title;
        }
    }

    return { next: first || firstSkipped };
}

function currentTitle() {
    if (focusId !== null) {
        const title = byId.get(focusId);

        if (title && filtered.includes(title)) {
            return title;
        }
    }

    return queueInfo().next;
}

/* Rating bars: ten rounded bars in the Watch List's style, one point each,
   clickable in half-point steps (left half of a bar is the half point). */

function barStrip(current) {
    const wrap = document.createElement("div");
    wrap.className = "bars bars--input";
    wrap.setAttribute("role", "slider");
    wrap.setAttribute("aria-label", "Rate and mark as seen");
    wrap.setAttribute("aria-valuemin", "0.5");
    wrap.setAttribute("aria-valuemax", "10");
    wrap.tabIndex = 0;

    for (let i = 0; i < 10; i += 1) {
        const bar = document.createElement("span");
        bar.className = "bar";
        wrap.append(bar);
    }

    paintBars(wrap, current);
    return wrap;
}

function paintBars(wrap, rating) {
    wrap.querySelectorAll(".bar").forEach((bar, index) => {
        const fill = rating === null ? 0 : Math.max(0, Math.min(1, rating - index));
        bar.style.setProperty("--fill", `${Math.round(fill * 100)}%`);
    });
    wrap.setAttribute("aria-valuenow", rating === null ? "" : String(rating));
}

/** Which rating a pointer position over the strip means, in half points. */
function barValue(wrap, event) {
    const rect = wrap.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    return Math.max(0.5, Math.min(10, Math.ceil(fraction * 20) / 2));
}

function tag(text, extra = "") {
    const span = document.createElement("span");
    span.className = `tag${extra ? ` ${extra}` : ""}`;
    span.textContent = text;
    return span;
}

function renderDeck() {
    const title = currentTitle();
    el.cardHolder.replaceChildren();

    if (!title) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.innerHTML = filtered.length === 0
            ? `<p class="empty__title">Nothing matches.</p><p>Loosen the filters or clear the search.</p>`
            : `<p class="empty__title">All decided.</p><p>Every ${poolNoun()} in this selection has an answer. Try other filters, or head to Export.</p>`;
        el.cardHolder.append(empty);
        el.actions.hidden = true;
        pendingRating = null;
        return;
    }

    el.actions.hidden = false;
    const mark = marks.get(title.id) || null;

    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = title.id;
    card.dataset.hint = "";
    card.tabIndex = -1;

    const poster = document.createElement("div");
    poster.className = "card__poster";

    const body = document.createElement("div");
    body.className = "card__body";

    const heading = document.createElement("h2");
    heading.className = "card__title";
    heading.textContent = title.title;
    body.append(heading);

    if (title.original) {
        const original = document.createElement("p");
        original.className = "card__original";
        original.textContent = title.original;
        body.append(original);
    }

    /* Movies: year · runtime · director. Shows: years · seasons · episodes · episode length. */
    const sub = document.createElement("p");
    sub.className = "card__sub";
    const parts = [`<strong>${formatYears(title)}</strong>`];

    if (title.kind === "show") {
        if (title.seasons) {
            parts.push(plural(title.seasons, "season"));
        }

        if (title.episodes) {
            parts.push(plural(title.episodes, "episode"));
        }

        if (title.runtime) {
            parts.push(`${formatRuntime(title.runtime)} each`);
        }
    } else if (title.runtime) {
        parts.push(formatRuntime(title.runtime));
    }

    if (title.directors) {
        parts.push(escapeHtml(title.directors));
    }

    sub.innerHTML = parts.join(" · ");

    const meta = document.createElement("div");
    meta.className = "card__meta";

    if (prefs.kind === "both") {
        meta.append(tag(KINDS[title.kind].tag, "tag--kind"));
    }

    for (const genre of title.genres) {
        meta.append(tag(genre));
    }

    meta.append(tag(`IMDb ${title.rating.toFixed(1)} · ${formatVotes(title.votes)} votes`, "tag--muted"));

    const link = document.createElement("a");
    link.className = "card__link";
    link.href = imdbUrl(title);
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "IMDb ↗";
    meta.append(link);

    body.append(sub, meta);

    if (title.cast) {
        const cast = document.createElement("p");
        cast.className = "card__cast";
        cast.textContent = title.cast;
        body.append(cast);
    }

    const synopsis = document.createElement("p");
    synopsis.className = "card__synopsis";
    body.append(synopsis);

    const rate = document.createElement("div");
    rate.className = "rate";

    const label = document.createElement("span");
    label.className = "rate__label";
    label.textContent = "Rate it:";

    const bars = barStrip(mark?.r ?? null);

    const value = document.createElement("output");
    value.className = "rate__value";
    value.textContent = mark?.r ? `${mark.r}` : "";

    /* Touch only (shown by CSS on coarse pointers): nudge by half a point, or clear. */
    const stepper = (text, name) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "rate__step";
        button.textContent = text;
        button.setAttribute("aria-label", name);
        return button;
    };
    const minus = stepper("−", "Half a point lower");
    const plus = stepper("+", "Half a point higher");

    rate.append(label, bars, minus, value, plus);

    /* A pending rating shows on the bars and on the Seen button until it is saved. */
    const setPending = (rating) => {
        pendingRating = rating;
        paintBars(bars, rating ?? mark?.r ?? null);
        value.textContent = rating !== null ? String(rating) : mark?.r ? String(mark.r) : "";
        rate.classList.toggle("rate--pending", rating !== null);
        el.seenRating.textContent = rating !== null ? ` · ${rating}` : "";
    };

    setPending(null);

    minus.addEventListener("click", () => {
        const next = (pendingRating ?? 0) - 0.5;
        setPending(next >= 0.5 ? next : null);
    });

    plus.addEventListener("click", () => {
        setPending(Math.min(10, (pendingRating ?? 0) + 0.5));
    });

    const status = document.createElement("p");
    status.className = "card__status";

    if (mark) {
        status.textContent = `Currently marked: ${statusLabel(mark.s)}${mark.r ? `, ${mark.r}/10` : ""}. Choose again to change it.`;
    }

    card.append(poster, body, rate, status);

    /* Bars with a mouse: hover previews, click marks seen with that rating.
       With a finger or pen: tap or slide sets the pending rating only. */
    let lastPointer = "mouse";
    let scrubbing = false;

    bars.addEventListener("pointerdown", (event) => {
        lastPointer = event.pointerType;

        if (event.pointerType === "mouse") {
            return;
        }

        scrubbing = true;

        try {
            bars.setPointerCapture(event.pointerId);
        } catch {
            /* capture is a nicety; the slide still works inside the strip */
        }

        setPending(barValue(bars, event));
    });

    bars.addEventListener("pointermove", (event) => {
        if (event.pointerType === "mouse") {
            const rating = barValue(bars, event);
            paintBars(bars, rating);
            value.textContent = String(rating);
        } else if (scrubbing) {
            setPending(barValue(bars, event));
        }
    });

    const stopScrub = () => {
        scrubbing = false;
    };

    bars.addEventListener("pointerup", stopScrub);
    bars.addEventListener("pointercancel", stopScrub);

    bars.addEventListener("pointerleave", (event) => {
        if (event.pointerType === "mouse") {
            setPending(pendingRating);
        }
    });

    bars.addEventListener("click", (event) => {
        if (lastPointer === "mouse") {
            decide(title, SEEN, barValue(bars, event));
        }
    });

    attachSwipe(card, title);
    el.cardHolder.append(card);

    /* Synopsis and poster arrive from the chunk file; skip if the card moved on. */
    detailsFor(title).then((details) => {
        if (!card.isConnected) {
            return;
        }

        synopsis.textContent = details.synopsis;
        synopsis.hidden = !details.synopsis;

        if (details.image) {
            const img = document.createElement("img");
            img.alt = `${title.title} poster`;
            img.decoding = "async";
            img.src = details.image;
            img.addEventListener("load", () => poster.classList.add("card__poster--loaded"));
            img.addEventListener("error", () => img.remove());
            poster.append(img);
        }
    });

    /* Warm the next chunk so the poster after the boundary does not lag. */
    loadChunk(title.kind, chunkOf(title) + 1);
}

/** Drag the card left for not seen, right for seen. Touch and mouse alike. */
function attachSwipe(card, title) {
    let startX = 0;
    let dragging = false;
    let pointerId = null;

    card.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("a, button, .bars")) {
            return;
        }

        startX = event.clientX;
        pointerId = event.pointerId;
        dragging = false;
    });

    card.addEventListener("pointermove", (event) => {
        if (pointerId !== event.pointerId) {
            return;
        }

        const dx = event.clientX - startX;

        if (!dragging && Math.abs(dx) < 8) {
            return;
        }

        if (!dragging) {
            dragging = true;
            card.classList.add("card--dragging");
            card.classList.remove("card--settle");

            try {
                card.setPointerCapture(pointerId);
            } catch {
                /* Some browsers refuse capture for a pointer that already lifted; the drag still works. */
            }
        }

        const strength = Math.min(1, Math.abs(dx) / SWIPE_DISTANCE);
        card.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
        card.style.setProperty("--hint", String(strength));
        card.dataset.hint = dx > 0 ? `Seen${pendingRating !== null ? ` · ${pendingRating}` : ""}` : "Not seen";
        card.dataset.side = dx > 0 ? "right" : "left";
    });

    const finish = (event) => {
        if (pointerId !== event.pointerId) {
            return;
        }

        pointerId = null;

        if (!dragging) {
            return;
        }

        const dx = event.clientX - startX;
        card.classList.remove("card--dragging");

        if (Math.abs(dx) >= SWIPE_DISTANCE) {
            decide(title, dx > 0 ? SEEN : UNSEEN, dx > 0 ? pendingRating : null);
            return;
        }

        card.classList.add("card--settle");
        card.style.transform = "";
        card.style.setProperty("--hint", "0");
    };

    card.addEventListener("pointerup", finish);
    card.addEventListener("pointercancel", finish);
}

function renderRecent() {
    const last = history[history.length - 1];
    const title = last && byId.get(last.id);
    const mark = last && marks.get(last.id);

    if (!title || !mark) {
        el.recent.textContent = "";
        return;
    }

    el.recent.innerHTML = `Last: <strong>${escapeHtml(title.title)}</strong> (${formatYears(title)}) — ${statusLabel(mark.s)}${mark.r ? `, ${mark.r}/10` : ""}`;
}

function pressAction(name) {
    const button = el.actions.querySelector(`[data-action="${name}"]`);

    if (button) {
        button.classList.add("is-pressed");
        setTimeout(() => button.classList.remove("is-pressed"), 140);
    }
}

/* List -------------------------------------------------------------------- */

function statusOf(title) {
    return marks.get(title.id)?.s || "undecided";
}

function renderChips() {
    const c = counts(filtered);
    const options = [
        ["all", "All", filtered.length],
        ["undecided", "Undecided", filtered.length - c.decided - c[SKIP]],
        [SEEN, "Seen", c[SEEN]],
        [UNSEEN, "Not seen", c[UNSEEN]],
        [WANT, "Want to watch", c[WANT]],
        [SKIP, "Skipped", c[SKIP]],
    ];

    el.chips.replaceChildren(...options.map(([key, label, count]) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.dataset.status = key;
        chip.setAttribute("aria-pressed", String(prefs.status === key));
        chip.textContent = label;

        const badge = document.createElement("span");
        badge.className = "chip__count";
        badge.textContent = ` ${count.toLocaleString()}`;
        chip.append(badge);

        return chip;
    }));
}

function createListRow(title, position) {
    const mark = marks.get(title.id) || null;
    const tr = document.createElement("tr");
    tr.dataset.id = title.id;

    const rank = document.createElement("td");
    rank.className = "col--rank";
    rank.textContent = String(position);

    const cell = document.createElement("td");
    const name = document.createElement("a");
    name.className = "row__title";
    name.href = imdbUrl(title);
    name.target = "_blank";
    name.rel = "noopener";
    name.textContent = title.title;
    const year = document.createElement("span");
    year.className = "row__year";
    year.textContent = formatYears(title);
    cell.append(name, year);

    if (prefs.kind === "both") {
        const kind = document.createElement("span");
        kind.className = "row__kind";
        kind.textContent = KINDS[title.kind].tag;
        cell.append(kind);
    }

    const sub = document.createElement("span");
    sub.className = "row__sub";
    const bits = [];

    if (title.kind === "show" && title.seasons) {
        bits.push(plural(title.seasons, "season"));
    }

    bits.push(title.directors, title.cast, title.genres.join(", "));
    sub.textContent = bits.filter(Boolean).join(" · ");
    cell.append(sub);

    const imdb = document.createElement("td");
    imdb.className = "col--imdb";
    imdb.textContent = title.rating.toFixed(1);

    const answer = document.createElement("td");
    answer.className = "col--mark";
    answer.append(markControls(title, mark));

    tr.append(rank, cell, imdb, answer);
    return tr;
}

function markControls(title, mark) {
    const fragment = document.createDocumentFragment();

    const seg = document.createElement("span");
    seg.className = "seg";

    for (const [status, label, extra] of [[UNSEEN, "Not seen", ""], [WANT, "Want", " seg__button--want"], [SKIP, "Skip", " seg__button--skip"], [SEEN, "Seen", ""]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `seg__button${extra}`;
        button.dataset.status = status;
        button.setAttribute("aria-pressed", String(mark?.s === status));
        button.textContent = label;
        seg.append(button);
    }

    fragment.append(seg);

    if (mark?.s === SEEN) {
        const select = document.createElement("select");
        select.className = "row-rate";
        select.setAttribute("aria-label", `Rating for ${title.title}`);
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "unrated";
        select.append(none);

        for (let value = 10; value >= 0.5; value -= 0.5) {
            const option = document.createElement("option");
            option.value = String(value);
            option.textContent = String(value);
            option.selected = mark.r === value;
            select.append(option);
        }

        fragment.append(select);
    }

    return fragment;
}

function updateListRow(id) {
    const tr = el.rows.querySelector(`tr[data-id="${id}"]`);
    const title = byId.get(id);

    if (tr && title) {
        tr.querySelector(".col--mark").replaceChildren(markControls(title, marks.get(id) || null));
    }
}

function renderList() {
    renderChips();
    listRows = prefs.status === "all" ? filtered : filtered.filter((title) => statusOf(title) === prefs.status);
    listShown = 0;
    el.rows.replaceChildren();
    appendListRows();
}

function appendListRows() {
    const slice = listRows.slice(listShown, listShown + PAGE_SIZE);
    el.rows.append(...slice.map((title, offset) => createListRow(title, listShown + offset + 1)));
    listShown += slice.length;

    if (listRows.length === 0) {
        el.listMore.textContent = "Nothing here.";
    } else if (listShown < listRows.length) {
        el.listMore.textContent = `Showing ${listShown.toLocaleString()} of ${listRows.length.toLocaleString()}. Scroll for more.`;
    } else {
        el.listMore.textContent = plural(listRows.length, poolNoun());
    }

    /* On a tall screen the first page may not reach the fold, and the observer
       only fires on a change, so keep filling until the sentinel is off screen. */
    if (listShown < listRows.length && el.sentinel.getBoundingClientRect().top < window.innerHeight + 600) {
        setTimeout(appendListRows, 0);
    }
}

/* Export ------------------------------------------------------------------ */

function csvCell(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(values) {
    return values.map(csvCell).join(",");
}

function isoDate(epoch) {
    return epoch ? new Date(epoch).toISOString().slice(0, 10) : "";
}

const PIDDICUS_HEADER = `# Watch List
#
# One title per line:   Title | rating | notes
#   rating  out of 10, halves allowed (7, 7.5, 8 ...)
#   notes   optional
# A line "# anime", "# show" or "# movie" sets the type for the lines
# under it. Other # lines are comments. Blank lines are ignored.
`;

/** Rows grouped by kind, in the Watch List's own order (shows, then movies). */
function byKind(rows) {
    return KIND_ORDER
        .map((kind) => ({ kind, rows: rows.filter((row) => row.title.kind === kind) }))
        .filter((group) => group.rows.length > 0);
}

function ratingSuffix(mark) {
    return mark.r === null ? "" : ` — ${mark.r}/10`;
}

/**
 * Each format says which kinds it can carry and which scopes: the list
 * formats (Piddicus, Letterboxd, IMDb) take a seen list or a want-to-watch
 * list, one at a time, since that is how those sites import; the data
 * formats take any mix.
 */
const LIST_SCOPES = ["seen", "want"];
const ALL_SCOPES = Object.keys(SCOPES);

const FORMATS = [
    {
        id: "piddicus",
        name: "Piddicus Watch List",
        target: "watched.txt for piddicus.com",
        extension: "txt",
        mime: "text/plain",
        scopes: LIST_SCOPES,
        kinds: ["movie", "show"],
        build(rows) {
            const sections = byKind(rows).map(({ kind, rows: group }) => {
                const lines = group.map(({ title, mark }) => {
                    const name = title.title.replace(/\|/g, "/");

                    if (mark.s === WANT) {
                        return `${name} | | want to watch`;
                    }

                    return mark.r === null ? name : `${name} | ${mark.r}`;
                });
                return `# ${kind}\n${lines.join("\n")}\n`;
            });

            return `${PIDDICUS_HEADER}\n${sections.join("\n")}`;
        },
    },
    {
        id: "letterboxd",
        name: "Letterboxd",
        target: "letterboxd.com/import, as watched or as watchlist (movies only)",
        extension: "csv",
        mime: "text/csv",
        scopes: LIST_SCOPES,
        kinds: ["movie"],
        build(rows) {
            const header = csvLine(["imdbID", "Title", "Year", "Directors", "Rating10"]);
            const lines = rows.map(({ title, mark }) => csvLine([tconst(title.id), title.title, title.year, title.directors, mark.r ?? ""]));
            return `${header}\n${lines.join("\n")}\n`;
        },
    },
    {
        id: "imdb",
        name: "IMDb CSV",
        target: "Ratings or watchlist layout, for Trakt, Simkl, TMDB and others",
        extension: "csv",
        mime: "text/csv",
        scopes: LIST_SCOPES,
        kinds: ["movie", "show"],
        build(rows, scope) {
            const common = (title) => [
                title.title,
                title.original || title.title,
                imdbUrl(title),
                KINDS[title.kind].imdbType,
                title.rating.toFixed(1),
                title.runtime ?? "",
                title.year,
                title.genres.join(", "),
                title.votes,
                "",
                title.directors,
            ];

            /* IMDb exports a watchlist with list columns and ratings with rating columns; importers key on those. */
            if (scope === "want") {
                const header = csvLine(["Position", "Const", "Created", "Modified", "Description", "Title", "Original Title", "URL", "Title Type", "IMDb Rating", "Runtime (mins)", "Year", "Genres", "Num Votes", "Release Date", "Directors"]);
                const lines = rows.map(({ title, mark }, index) => csvLine([index + 1, tconst(title.id), isoDate(mark.t), isoDate(mark.t), "", ...common(title)]));
                return `${header}\n${lines.join("\n")}\n`;
            }

            const header = csvLine(["Const", "Your Rating", "Date Rated", "Title", "Original Title", "URL", "Title Type", "IMDb Rating", "Runtime (mins)", "Year", "Genres", "Num Votes", "Release Date", "Directors"]);
            const lines = rows.map(({ title, mark }) => csvLine([tconst(title.id), mark.r === null ? "" : Math.round(mark.r), isoDate(mark.t), ...common(title)]));
            return `${header}\n${lines.join("\n")}\n`;
        },
    },
    {
        id: "csv",
        name: "Plain CSV",
        target: "Spreadsheets and anything else",
        extension: "csv",
        mime: "text/csv",
        scopes: ALL_SCOPES,
        kinds: ["movie", "show"],
        build(rows) {
            const header = csvLine(["imdb_id", "type", "title", "year", "end_year", "status", "rating", "directors", "cast", "genres", "runtime_min", "seasons", "episodes", "imdb_rating", "imdb_votes", "marked"]);
            const lines = rows.map(({ title, mark }) => csvLine([
                tconst(title.id), title.kind, title.title, title.year, title.endYear ?? "", mark.s, mark.r ?? "", title.directors, title.cast, title.genres.join("; "),
                title.runtime ?? "", title.seasons ?? "", title.episodes ?? "", title.rating.toFixed(1), title.votes, isoDate(mark.t),
            ]));
            return `${header}\n${lines.join("\n")}\n`;
        },
    },
    {
        id: "json",
        name: "JSON backup",
        target: "Load back in here to restore progress",
        extension: "json",
        mime: "application/json",
        scopes: ALL_SCOPES,
        kinds: ["movie", "show"],
        build(rows) {
            return `${JSON.stringify({
                app: "scene-it",
                version: 2,
                exported: new Date().toISOString(),
                titles: rows.map(({ title, mark }) => ({
                    id: tconst(title.id),
                    type: title.kind,
                    title: title.title,
                    year: title.year,
                    status: mark.s,
                    rating: mark.r,
                    marked: mark.t ? new Date(mark.t).toISOString() : null,
                })),
            }, null, 2)}\n`;
        },
    },
    {
        id: "text",
        name: "Text list",
        target: "Paste anywhere",
        extension: "txt",
        mime: "text/plain",
        scopes: ALL_SCOPES,
        kinds: ["movie", "show"],
        build(rows) {
            const line = ({ title, mark }) => `${title.title} (${formatYears(title)})${ratingSuffix(mark)}`;
            const groups = byKind(rows);
            const heading = (text) => `${text}\n${"-".repeat(text.length)}`;

            const section = (group) => {
                const statuses = STATUSES
                    .map((status) => ({ status, items: group.rows.filter((row) => row.mark.s === status) }))
                    .filter((s) => s.items.length > 0);

                if (statuses.length === 1) {
                    return statuses[0].items.map(line).join("\n");
                }

                return statuses.map((s) => `${heading(statusLabel(s.status))}\n${s.items.map(line).join("\n")}`).join("\n\n");
            };

            if (groups.length === 1) {
                return `${section(groups[0])}\n`;
            }

            return groups.map((group) => `${heading(group.kind === "show" ? "TV shows" : "Movies").toUpperCase()}\n\n${section(group)}`).join("\n\n\n") + "\n";
        },
    },
    {
        id: "markdown",
        name: "Markdown checklist",
        target: "Notes apps, GitHub, Obsidian",
        extension: "md",
        mime: "text/markdown",
        scopes: ALL_SCOPES,
        kinds: ["movie", "show"],
        build(rows) {
            const note = (mark) => (mark.s === WANT ? " — want to watch" : mark.s === SKIP ? " — skipped" : ratingSuffix(mark));
            const item = ({ title, mark }) => `- [${mark.s === SEEN ? "x" : " "}] ${title.title} (${formatYears(title)})${note(mark)}`;
            const groups = byKind(rows);

            if (groups.length === 1) {
                return `${groups[0].rows.map(item).join("\n")}\n`;
            }

            return groups.map((group) => `## ${group.kind === "show" ? "TV shows" : "Movies"}\n\n${group.rows.map(item).join("\n")}`).join("\n\n") + "\n";
        },
    },
];

/** Marked titles among the kinds the switch covers, in popularity order. */
function exportRows(subset, kinds) {
    const allowed = SCOPES[subset] || SCOPES.seen;
    const rows = [];

    for (const title of pool) {
        const mark = marks.get(title.id);

        if (mark && allowed.includes(mark.s) && kinds.includes(title.kind)) {
            rows.push({ title, mark });
        }
    }

    rows.sort((a, b) => b.title.votes - a.title.votes);
    return rows;
}

function currentFormat() {
    return FORMATS.find((format) => format.id === prefs.format) || FORMATS[0];
}

/** The scope the current format can carry: watched-list formats take a seen list or a want-to-watch list, nothing mixed. */
function currentScope(format = currentFormat()) {
    return format.scopes.includes(prefs.subset) ? prefs.subset : "seen";
}

function buildExport() {
    const format = currentFormat();
    const kinds = activeKinds().filter((kind) => format.kinds.includes(kind));
    const scope = currentScope(format);
    const rows = exportRows(scope, kinds);
    const skipped = activeKinds().filter((kind) => !format.kinds.includes(kind));
    return { format, rows, kinds, scope, skipped, text: rows.length ? format.build(rows, scope) : "" };
}

function renderExport() {
    const c = counts();
    const average = c.rated ? (c.ratingSum / c.rated).toFixed(1) : "—";

    el.stats.replaceChildren(...[
        [c[SEEN], "seen"],
        [c[UNSEEN], "not seen"],
        [c[WANT], "want to watch"],
        [c[SKIP], "skipped"],
        [c.rated, "rated"],
        [average, "average rating"],
    ].map(([value, label]) => {
        const stat = document.createElement("div");
        stat.className = "stat";
        stat.innerHTML = `<p class="stat__value">${typeof value === "number" ? value.toLocaleString() : value}</p><p class="stat__label">${label}</p>`;
        return stat;
    }));

    el.formats.replaceChildren(...FORMATS.map((format) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "format";
        button.dataset.format = format.id;
        button.setAttribute("aria-pressed", String(format.id === prefs.format));
        button.innerHTML = `<span class="format__name">${format.name}</span><span class="format__for">${format.target}</span>`;
        return button;
    }));

    const { format, rows, scope, skipped, text } = buildExport();

    for (const radio of el.subset.querySelectorAll("input")) {
        radio.disabled = !format.scopes.includes(radio.value);
        radio.checked = radio.value === scope;
    }

    el.preview.value = text;
    el.preview.placeholder = rows.length ? "" : `Nothing to export yet. Mark some ${poolNoun()}s first.`;
    el.download.textContent = `Download .${format.extension}`;
    el.openWatchList.hidden = !(format.id === "piddicus" && window.location.pathname.includes("/projects/"));

    const parts = [];

    if (rows.length) {
        parts.push(`${plural(rows.length, skipped.length || prefs.kind !== "both" ? KINDS[rows[0].title.kind].label : "title")} in this export.`);
    }

    if (skipped.length) {
        parts.push(`${format.name} has no ${KINDS[skipped[0]].plural === "shows" ? "TV" : KINDS[skipped[0]].label} import, so ${KINDS[skipped[0]].plural} are left out.`);
    }

    el.exportStatus.textContent = parts.join(" ");
}

function downloadFile(name, content, type) {
    const blob = new Blob([content], { type });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 500);
}

/* Import ------------------------------------------------------------------ */

/** A CSV parser that copes with quoted commas and newlines (Letterboxd reviews have both). */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];

        if (quoted) {
            if (char === '"' && text[i + 1] === '"') {
                cell += '"';
                i += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                cell += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ",") {
            row.push(cell);
            cell = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[i + 1] === "\n") {
                i += 1;
            }

            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
        } else {
            cell += char;
        }
    }

    if (cell || row.length) {
        row.push(cell);
        rows.push(row);
    }

    return rows.filter((line) => line.some((value) => value.trim() !== ""));
}

const titleIndex = new Map();

function indexTitles(titles) {
    for (const title of titles) {
        for (const key of [title.key, title.originalKey]) {
            if (key) {
                if (!titleIndex.has(key)) {
                    titleIndex.set(key, []);
                }

                titleIndex.get(key).push(title);
            }
        }
    }
}

/** Match by normalised title, then year (within one), then popularity; kind narrows when known. */
function findByTitle(text, year, kind = null) {
    let candidates = titleIndex.get(normalizeTitle(text));

    if (!candidates) {
        return null;
    }

    if (kind) {
        candidates = candidates.filter((title) => title.kind === kind);
    }

    if (candidates.length === 0) {
        return null;
    }

    if (year) {
        const close = candidates.filter((title) => Math.abs(title.year - year) <= 1);

        if (close.length) {
            return close.sort((a, b) => Math.abs(a.year - year) - Math.abs(b.year - year) || b.votes - a.votes)[0];
        }

        return null;
    }

    return candidates.length === 1 ? candidates[0] : candidates.sort((a, b) => b.votes - a.votes)[0];
}

function findById(text) {
    const match = /tt(\d+)/i.exec(String(text || ""));
    return match ? byId.get(Number(match[1])) || null : null;
}

function kindFromWord(word) {
    const w = String(word || "").toLowerCase();

    if (["show", "anime", "tv", "tv series", "tvseries", "tv mini series", "tvminiseries", "series"].includes(w)) {
        return "show";
    }

    return w === "movie" ? "movie" : null;
}

/** Turn any supported file into [{ title, status, rating }]. */
function parseImport(name, text) {
    const found = [];
    let total = 0;

    if (name.endsWith(".json") || text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
        const data = JSON.parse(text);
        const items = Array.isArray(data) ? data : Array.isArray(data.titles) ? data.titles : Array.isArray(data.movies) ? data.movies : [];

        for (const item of items) {
            total += 1;
            const title = findById(item.id || item.imdbID || item.imdb_id) || findByTitle(item.title || item.name, Number(item.year), kindFromWord(item.type));

            if (title) {
                const status = STATUSES.includes(item.status) ? item.status : SEEN;
                found.push({ title, status, rating: cleanRating(item.rating ?? item.rating10) });
            }
        }

        return { found, total };
    }

    if (name.endsWith(".csv")) {
        const [header, ...lines] = parseCsv(text);
        const columns = header.map((column) => column.trim().toLowerCase());
        const column = (...names) => names.map((n) => columns.indexOf(n)).find((i) => i >= 0) ?? -1;

        const idColumn = column("imdbid", "const", "imdb_id", "imdb id");
        const titleColumn = column("title", "name");
        const yearColumn = column("year");
        const typeColumn = column("type", "title type");
        const rating10Column = column("rating10", "your rating");
        const ratingColumn = column("rating");
        const statusColumn = column("status");
        const letterboxdScale = columns.includes("letterboxd uri") || columns.includes("watched date");

        /* A Letterboxd watchlist.csv, or an IMDb list export (Position column,
           no Your Rating), is a to-watch list rather than a watched one. */
        const isWatchlist = name.includes("watchlist") || (columns.includes("position") && !columns.includes("your rating"));
        const defaultStatus = isWatchlist ? WANT : SEEN;

        for (const values of lines) {
            total += 1;
            const get = (index) => (index >= 0 ? values[index] ?? "" : "");
            const title = findById(get(idColumn)) || (titleColumn >= 0 ? findByTitle(get(titleColumn), Number(get(yearColumn)), kindFromWord(get(typeColumn))) : null);

            if (!title) {
                continue;
            }

            let rating = null;

            if (rating10Column >= 0 && get(rating10Column) !== "") {
                rating = cleanRating(get(rating10Column));
            } else if (ratingColumn >= 0 && get(ratingColumn) !== "") {
                const raw = Number.parseFloat(get(ratingColumn));
                rating = cleanRating(letterboxdScale ? raw * 2 : raw);
            }

            const status = statusColumn >= 0 && STATUSES.includes(get(statusColumn)) ? get(statusColumn) : defaultStatus;
            found.push({ title, status, rating });
        }

        return { found, total };
    }

    /* Piddicus text: "Title | rating | notes" lines under "# type" lines. The
       section says whether to look among shows or movies; without one, both. */
    let kind = null;

    for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
        const line = raw.trim();

        if (!line) {
            continue;
        }

        if (line.startsWith("#")) {
            kind = kindFromWord(line.slice(1).trim()) ?? kind;
            continue;
        }

        total += 1;
        const [name, rating, ...rest] = line.split("|").map((part) => part.trim());
        const yearMatch = /\((\d{4})\)\s*$/.exec(name);
        const title = findByTitle(yearMatch ? name.slice(0, yearMatch.index) : name, yearMatch ? Number(yearMatch[1]) : 0, kind);

        if (title) {
            const wants = /want to watch|to watch|watchlist/i.test(rest.join(" "));
            found.push({ title, status: wants ? WANT : SEEN, rating: wants ? null : cleanRating(rating) });
        }
    }

    return { found, total };
}

/* Transfer: answers packed into a short code, to carry to another browser --- */

/**
 * The site has no server, so moving to another browser means carrying the
 * answers yourself. A transfer code is every answer as a few bytes (the gap
 * to the previous IMDb id, then one byte of status and rating), compressed
 * and written as URL-safe base64. It travels as a link (after "#t=", a part
 * of the address browsers never send to a server) or as plain text to paste.
 * Marking times are not carried. The code depends on the order of STATUSES.
 */
const TRANSFER_HASH = "#t=";

function toBase64Url(bytes) {
    let binary = "";

    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }

    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function pipeBytes(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

async function encodeTransfer() {
    const ids = [...marks.keys()].sort((a, b) => a - b);
    const bytes = [];
    let previous = 0;

    for (const id of ids) {
        const mark = marks.get(id);
        let gap = id - previous;
        previous = id;

        while (gap > 127) {
            bytes.push((gap % 128) + 128);
            gap = Math.floor(gap / 128);
        }

        bytes.push(gap, STATUSES.indexOf(mark.s) * 32 + (mark.r === null ? 0 : Math.round(mark.r * 2)));
    }

    const raw = new Uint8Array(bytes);

    if ("CompressionStream" in window) {
        return `1z${toBase64Url(await pipeBytes(raw, new CompressionStream("deflate-raw")))}`;
    }

    return `1r${toBase64Url(raw)}`;
}

/** Accepts a bare code or a whole link containing one; returns [{ id, status, rating }]. */
async function decodeTransfer(input) {
    let code = String(input || "").trim();
    const at = code.indexOf(TRANSFER_HASH);

    if (at >= 0) {
        code = code.slice(at + TRANSFER_HASH.length);
    }

    const tag = code.slice(0, 2);
    let bytes = fromBase64Url(code.slice(2));

    if (tag === "1z") {
        bytes = await pipeBytes(bytes, new DecompressionStream("deflate-raw"));
    } else if (tag !== "1r") {
        throw new Error("not a transfer code");
    }

    const entries = [];
    let id = 0;
    let i = 0;

    while (i < bytes.length) {
        let gap = 0;
        let scale = 1;

        while (bytes[i] > 127) {
            gap += (bytes[i] - 128) * scale;
            scale *= 128;
            i += 1;
        }

        gap += bytes[i] * scale;
        const packed = bytes[i + 1];
        i += 2;

        if (packed === undefined) {
            throw new Error("transfer code is cut short");
        }

        id += gap;
        const status = STATUSES[Math.floor(packed / 32)];
        const half = packed % 32;

        if (!status || half > 20) {
            throw new Error("transfer code is damaged");
        }

        entries.push({ id, status, rating: half ? half / 2 : null });
    }

    return entries;
}

/** Merge a transfer code into this browser: its answers win for the titles it mentions. */
async function importTransfer(input, statusTarget) {
    let entries;

    try {
        entries = await decodeTransfer(input);
    } catch (error) {
        console.error(error);
        say(statusTarget, "That is not a valid link or code.");
        return false;
    }

    if (entries.length === 0) {
        say(statusTarget, "That code has no answers in it.");
        return false;
    }

    const clashes = entries.filter((entry) => marks.has(entry.id)).length;
    const message = `Import ${entries.length.toLocaleString()} answers from the other browser?${clashes ? ` ${clashes.toLocaleString()} of them replace answers already here.` : ""}`;

    if (!window.confirm(message)) {
        say(statusTarget, "Import cancelled.");
        return false;
    }

    const now = Date.now();

    for (const entry of entries) {
        marks.set(entry.id, { s: entry.status, r: entry.status === SEEN ? entry.rating : null, t: now });
    }

    saveMarks();
    history.length = 0;
    focusId = null;
    renderProgress();
    renderRecent();
    renderView();
    say(statusTarget, `Imported ${entries.length.toLocaleString()} answers.`);
    return true;
}

async function copyTransfer(asLink) {
    if (marks.size === 0) {
        say(el.transferStatus, "Nothing to transfer yet.");
        return;
    }

    const code = await encodeTransfer();
    const text = asLink ? `${window.location.origin}${window.location.pathname}${TRANSFER_HASH}${code}` : code;

    try {
        await navigator.clipboard.writeText(text);
        say(el.transferStatus, `Copied ${asLink ? "a link" : "a code"} with ${marks.size.toLocaleString()} answers. Open or paste it in the other browser.`);
    } catch {
        el.transferInput.value = text;
        el.transferInput.select();
        say(el.transferStatus, "Copy the text in the box.");
    }
}

/** A link opened from another browser carries its answers after "#t=". */
async function importFromAddress() {
    if (!window.location.hash.startsWith(TRANSFER_HASH)) {
        return;
    }

    const hash = window.location.hash;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    showView("export");
    await importTransfer(hash, el.transferStatus);
}

async function importFile(file) {
    try {
        /* Both lists are needed to match whatever the file mentions. */
        await Promise.all(Object.keys(KINDS).map(loadKind));

        const { found, total } = parseImport(file.name.toLowerCase(), await file.text());

        if (found.length === 0) {
            say(el.importStatus, `No matches in ${file.name}.`);
            return;
        }

        const missed = total - found.length;
        const message = `Apply ${found.length.toLocaleString()} matches from ${file.name}?${missed ? ` (${missed.toLocaleString()} rows were not in the lists.)` : ""}`;

        if (!window.confirm(message)) {
            say(el.importStatus, "Import cancelled.");
            return;
        }

        for (const { title, status, rating } of found) {
            setMark(title, status, rating, { record: false });
        }

        history.length = 0;
        focusId = null;
        renderProgress();
        renderRecent();
        renderView();
        say(el.importStatus, `Imported ${found.length.toLocaleString()} of ${total.toLocaleString()} rows.`);
    } catch (error) {
        console.error(error);
        say(el.importStatus, `Could not read ${file.name}.`);
    }
}

/* Views ------------------------------------------------------------------- */

function say(target, message) {
    target.textContent = message;
    clearTimeout(target.sayTimer);
    target.sayTimer = setTimeout(() => {
        if (target.textContent === message) {
            target.textContent = "";
        }
    }, 4000);
}

function showView(name) {
    prefs.view = name;
    savePrefs();

    for (const tab of el.tabs.querySelectorAll(".tab")) {
        tab.setAttribute("aria-selected", String(tab.dataset.view === name));
    }

    el.viewDeck.hidden = name !== "deck";
    el.viewList.hidden = name !== "list";
    el.viewExport.hidden = name !== "export";
    renderView();
}

function renderView() {
    if (prefs.view === "deck") {
        renderDeck();
    } else if (prefs.view === "list") {
        renderList();
    } else {
        renderExport();
    }
}

/* Wiring ------------------------------------------------------------------ */

/** Rebuild the decade and genre menus from the titles in the pool, keeping the choice when it still exists. */
function fillFilterOptions() {
    const genres = new Set();
    const decades = new Set();

    for (const title of pool) {
        title.genres.forEach((genre) => genres.add(genre));
        decades.add(decadeOf(title.year));
    }

    const rebuild = (select, values, labelOf, current) => {
        const first = select.options[0];
        select.replaceChildren(first);

        for (const value of values) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = labelOf(value);
            select.append(option);
        }

        select.value = current;

        if (select.selectedIndex < 0) {
            select.value = "";
        }

        return select.value;
    };

    prefs.genre = rebuild(el.genre, [...genres].sort(), (g) => g, prefs.genre);

    const sortedDecades = [...decades].filter((d) => d !== "old").sort((a, b) => Number(b) - Number(a));

    if (decades.has("old")) {
        sortedDecades.push("old");
    }

    prefs.decade = rebuild(el.decade, sortedDecades, (d) => (d === "old" ? "Before 1950" : `${d}s`), prefs.decade);

    if (el.minRating.options.length === 1) {
        for (let value = 4; value <= 9; value += 0.5) {
            const option = document.createElement("option");
            option.value = String(value);
            option.textContent = `IMDb ${value.toFixed(1)}+`;
            el.minRating.append(option);
        }
    }

    el.order.value = prefs.order;
    el.minRating.value = String(Number(prefs.minRating) || 0);

    if (el.minRating.selectedIndex < 0) {
        el.minRating.value = "0";
        prefs.minRating = 0;
    }
}

function onKey(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
        return;
    }

    const target = event.target instanceof Element ? event.target : document.body;

    if (target.matches("input, textarea, select") || el.help.open) {
        if (event.key === "Escape" && target.matches("input")) {
            target.blur();
        }

        return;
    }

    /* Enter or Space on a focused button or link should just activate it. */
    if ((event.key === "Enter" || event.key === " ") && target.closest("button, a, summary")) {
        return;
    }

    if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
        event.preventDefault();
        el.help.showModal();
        return;
    }

    if (event.key === "/") {
        event.preventDefault();
        el.search.focus();
        return;
    }

    const kindKey = { m: "movie", M: "movie", t: "show", T: "show", b: "both", B: "both" }[event.key];

    if (kindKey) {
        event.preventDefault();
        setKind(kindKey);
        return;
    }

    if (prefs.view !== "deck") {
        return;
    }

    const title = currentTitle();

    if (event.key === "z" || event.key === "Z" || event.key === "Backspace") {
        event.preventDefault();
        undo();
        return;
    }

    if (!title) {
        return;
    }

    if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        decide(title, SEEN, event.key === "0" ? 10 : Number(event.key));
        pressAction("seen");
        return;
    }

    switch (event.key) {
        case "ArrowRight":
        case "s":
        case "S":
        case "Enter":
            event.preventDefault();
            pressAction("seen");
            decide(title, SEEN, pendingRating);
            break;
        case "ArrowLeft":
        case "n":
        case "N":
        case "x":
        case "X":
            event.preventDefault();
            pressAction("unseen");
            decide(title, UNSEEN);
            break;
        case "ArrowUp":
        case "w":
        case "W":
            event.preventDefault();
            pressAction("want");
            decide(title, WANT);
            break;
        case "ArrowDown":
        case " ":
        case "k":
        case "K":
            event.preventDefault();
            pressAction("skip");
            decide(title, SKIP);
            break;
        default:
    }
}

function wire() {
    el.tabs.addEventListener("click", (event) => {
        const tab = event.target.closest(".tab");

        if (tab) {
            showView(tab.dataset.view);
        }
    });

    el.kinds.addEventListener("click", (event) => {
        const button = event.target.closest("[data-kind]");

        if (button) {
            setKind(button.dataset.kind);
        }
    });

    for (const [element, key] of [[el.order, "order"], [el.decade, "decade"], [el.genre, "genre"], [el.minRating, "minRating"]]) {
        element.addEventListener("change", () => {
            prefs[key] = key === "minRating" ? Number(element.value) : element.value;
            focusId = null;
            savePrefs();
            applyFilters();
        });
    }

    el.shuffle.addEventListener("click", () => {
        prefs.seed = Math.floor(Math.random() * 2 ** 31);
        savePrefs();
        applyFilters();
    });

    let searchTimer = 0;
    el.search.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            searchQuery = el.search.value;
            focusId = null;
            applyFilters();
        }, 120);
    });

    el.actions.addEventListener("click", (event) => {
        const button = event.target.closest("[data-action]");
        const title = currentTitle();

        if (!button || !title) {
            return;
        }

        const status = { seen: SEEN, unseen: UNSEEN, want: WANT, skip: SKIP }[button.dataset.action];
        decide(title, status, status === SEEN ? pendingRating : null);
    });

    el.undo.addEventListener("click", undo);
    el.helpButton.addEventListener("click", () => el.help.showModal());
    el.helpClose.addEventListener("click", () => el.help.close());
    el.help.addEventListener("click", (event) => {
        if (event.target === el.help) {
            el.help.close();
        }
    });

    document.addEventListener("keydown", onKey);

    el.chips.addEventListener("click", (event) => {
        const chip = event.target.closest(".chip");

        if (chip) {
            prefs.status = chip.dataset.status;
            savePrefs();
            renderList();
        }
    });

    el.rows.addEventListener("click", (event) => {
        const button = event.target.closest(".seg__button");
        const tr = event.target.closest("tr");

        if (!button || !tr) {
            return;
        }

        const title = byId.get(Number(tr.dataset.id));
        const current = marks.get(title.id);
        const status = button.dataset.status;
        const next = current?.s === status ? null : status;
        setMark(title, next, next === SEEN ? current?.r ?? null : null);
        renderProgress();
        updateListRow(title.id);
        renderChips();
    });

    el.rows.addEventListener("change", (event) => {
        const select = event.target.closest(".row-rate");
        const tr = event.target.closest("tr");

        if (!select || !tr) {
            return;
        }

        const title = byId.get(Number(tr.dataset.id));
        setMark(title, SEEN, cleanRating(select.value));
        renderProgress();
    });

    const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !el.viewList.hidden && listShown < listRows.length) {
            appendListRows();
        }
    }, { rootMargin: "600px 0px" });
    observer.observe(el.sentinel);

    el.formats.addEventListener("click", (event) => {
        const button = event.target.closest(".format");

        if (button) {
            prefs.format = button.dataset.format;
            savePrefs();
            renderExport();
        }
    });

    el.subset.addEventListener("change", (event) => {
        if (event.target.matches("input")) {
            prefs.subset = event.target.value;
            savePrefs();
            renderExport();
        }
    });

    el.copy.addEventListener("click", async () => {
        const { text } = buildExport();

        if (!text) {
            say(el.exportStatus, "Nothing to copy yet.");
            return;
        }

        try {
            await navigator.clipboard.writeText(text);
            say(el.exportStatus, "Copied.");
        } catch {
            el.preview.select();
            say(el.exportStatus, "Select the text below and copy it.");
        }
    });

    el.download.addEventListener("click", () => {
        const { format, text } = buildExport();

        if (!text) {
            say(el.exportStatus, "Nothing to download yet.");
            return;
        }

        const kindPart = prefs.kind === "both" ? "" : `-${KINDS[prefs.kind].plural}`;
        const scopePart = currentScope() === "seen" ? "" : `-${currentScope()}`;
        downloadFile(`scene-it${kindPart}${scopePart}-${format.id}.${format.extension}`, text, format.mime);
    });

    el.openWatchList.addEventListener("click", () => {
        const scope = currentScope(FORMATS[0]);
        const rows = exportRows(scope, activeKinds());

        if (rows.length === 0) {
            say(el.exportStatus, scope === "want" ? "Mark something as want to watch first." : "Mark something as seen first.");
            return;
        }

        localStorage.setItem(WATCH_LIST_OVERRIDE_KEY, FORMATS[0].build(rows, scope));
        window.location.href = WATCH_LIST_PAGE;
    });

    el.importFile.addEventListener("change", async () => {
        const file = el.importFile.files[0];

        if (file) {
            await importFile(file);
        }

        el.importFile.value = "";
    });

    el.transferLink.addEventListener("click", () => copyTransfer(true));
    el.transferCode.addEventListener("click", () => copyTransfer(false));

    el.transferImport.addEventListener("click", async () => {
        if (!el.transferInput.value.trim()) {
            say(el.transferStatus, "Paste a link or code first.");
            return;
        }

        if (await importTransfer(el.transferInput.value, el.transferStatus)) {
            el.transferInput.value = "";
        }
    });

    el.transferInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            el.transferImport.click();
        }
    });

    el.reset.addEventListener("click", () => {
        if (marks.size === 0) {
            say(el.importStatus, "Nothing to reset.");
            return;
        }

        if (window.confirm(`Forget all ${marks.size.toLocaleString()} answers, movies and shows alike? Export a JSON backup first if you might want them back.`)) {
            marks.clear();
            history.length = 0;
            focusId = null;
            saveMarks();
            renderProgress();
            renderRecent();
            renderView();
            say(el.importStatus, "Progress cleared.");
        }
    });
}

/* Start ------------------------------------------------------------------- */

async function start() {
    loadPrefs();
    loadMarks();
    wire();

    try {
        await Promise.all(activeKinds().map(loadKind));
    } catch (error) {
        console.error(error);
        el.loading.textContent = "The title list could not be loaded.";
        return;
    }

    el.loading.hidden = true;
    el.app.hidden = false;

    await setKind(prefs.kind);
    renderRecent();
    showView(["deck", "list", "export"].includes(prefs.view) ? prefs.view : "deck");
    importFromAddress();

    /* Fetch the other list quietly so the switch feels instant. */
    for (const kind of Object.keys(KINDS)) {
        if (!datasets[kind]) {
            setTimeout(() => loadKind(kind).catch(() => {}), 2000);
        }
    }
}

start();
