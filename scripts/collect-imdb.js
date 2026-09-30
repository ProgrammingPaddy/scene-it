/**
 * Browser-side collector for IMDb plot outlines and posters.
 *
 * IMDb's title pages carry structured data (JSON-LD) with the short plot
 * outline and the poster, but the pages only load in a real browser. So:
 *
 *   1. Run `python scripts/collect-server.py` (listens on localhost:8792).
 *   2. Open any imdb.com title page in a browser.
 *   3. Paste this whole file into the browser console and press Enter.
 *
 * It asks the local server which ids are still missing, fetches each title
 * page from the same origin, reads only as far as the JSON-LD block (a few
 * tens of KB rather than the whole 1.7 MB page), and posts results back in
 * batches. Progress is in window.__collect; the loop resumes from the cache
 * if the page is reloaded and the script pasted again.
 *
 * Pace: one page at a time with a short pause. IMDb starts answering 403 to
 * a session that goes faster; when that happens the script waits a couple of
 * minutes and carries on with the same id. Stop it with
 * `__collect.running = false`.
 */

(() => {
    const SERVER = "http://127.0.0.1:8792";
    const CONCURRENCY = 1;
    const PAUSE_MS = 800;
    const BLOCKED_WAIT_MS = 120000;
    const BATCH = 25;
    const MARKER = '<script type="application/ld+json">';

    const state = (window.__collect = { done: 0, failed: [], pending: [], running: true, started: Date.now() });

    const decodeEntities = (text) => {
        const area = document.createElement("textarea");
        area.innerHTML = text;
        return area.value;
    };

    async function grab(id) {
        const response = await fetch(`/title/${id}/`, { credentials: "same-origin" });

        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { value, done } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const start = buffer.indexOf(MARKER);

            if (start >= 0) {
                const end = buffer.indexOf("</script>", start);

                if (end > 0) {
                    reader.cancel().catch(() => {});
                    const data = JSON.parse(buffer.slice(start + MARKER.length, end));
                    return [decodeEntities(data.description || ""), data.image || ""];
                }
            }

            if (buffer.length > 4e6) {
                break;
            }
        }

        throw new Error("no structured data");
    }

    async function flush() {
        if (state.pending.length === 0) {
            return;
        }

        const rows = state.pending.splice(0);
        await fetch(SERVER, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rows) });
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function worker(queue) {
        while (state.running && queue.length) {
            const id = queue.shift();

            try {
                const value = await grab(id);
                state.pending.push({ key: id, value });
                state.done += 1;
                state.blocked = 0;

                if (state.pending.length >= BATCH) {
                    await flush();
                }
            } catch (error) {
                if (/HTTP (403|429|5\d\d|202)/.test(error.message)) {
                    // IMDb is refusing the session for now: put the id back,
                    // wait a couple of minutes, and slow down further.
                    queue.unshift(id);
                    state.blocked = (state.blocked || 0) + 1;
                    state.lastBlock = new Date().toLocaleTimeString();
                    await flush();
                    await sleep(BLOCKED_WAIT_MS * Math.min(state.blocked, 4));
                } else {
                    state.failed.push([id, error.message]);
                }
            }

            await sleep(PAUSE_MS);
        }
    }

    (async () => {
        const { todo } = await (await fetch(`${SERVER}/todo`)).json();
        state.total = todo.length;
        const queue = todo.slice();
        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

        // One more pass over anything that failed, slowly.
        const retry = state.failed.map(([id]) => id);
        state.failed = [];
        for (const id of retry) {
            if (!state.running) break;
            try {
                state.pending.push({ key: id, value: await grab(id) });
                state.done += 1;
            } catch (error) {
                state.failed.push([id, error.message]);
            }
            await sleep(2000);
        }

        await flush();
        state.running = false;
        state.finished = Date.now();
    })();

    return "collecting";
})();
