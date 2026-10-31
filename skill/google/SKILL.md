---
name: google
description: Search Google in the remote Chrome and return the top results. Use for "/google <query>", "google this", or any quick web lookup in the NAS browser.
---

# /google

The browser is headful with a real Chrome UA and a persistent profile, so Google
search works from the NAS now. Use real Google results first; fall back to the
search index only if Google challenges.

## Steps

1. **Search — one call.**

   ```json
   {"url":"https://www.google.com/search?q=<URL-ENCODED QUERY>",
    "observe":true,"max":120,"input":"dom"}
   ```

   Use `chrome_task` (or `chrome_open`). Do not type into the home page first;
   the direct results URL is one round trip.

2. **If Google challenges** — the URL contains `/sorry/` or the title says
   “unusual traffic”. Do not solve or bypass it. Say so, open
   `https://www.google.com` (home), and get the same query with ONE
   `crawl.search_scrape` call (`{"query":"…","max_results":5}`). Label those
   results “search-index fallback (Google challenged the NAS browser)”.

3. **Extract — one call** (`chrome_eval`):

   ```js
   const items = [...document.querySelectorAll('#search a h3')].slice(0, 8).map(h => {
     const a = h.closest('a');
     const block = h.closest('div.MjjYud') || h.closest('div');
     return { title: h.innerText, url: a && a.href, snippet: ((block && block.innerText) || '').slice(0, 220) };
   });
   return { title: document.title, url: location.href, items };
   ```

4. **Answer** — top 3–5 results with titles and links, plus a one-line summary.

5. **Watch link** — `https://chrome.inkwork.studio/google?session=<session-id>`.
   Leave the browser on the results page. Do not close the session unless the
   user asks.

## Rules

- One prompt = one search. No engine sweep.
- The headful browser now works; if it stops working, the fallback is ONE crawl
  call, not another engine.
- Never solve, outsource, or attempt to bypass a CAPTCHA.
- Never print the long MCP token; the PIN is for the human console only.
