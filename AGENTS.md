# AGENTS.md — chrome.inkwork.studio

You are in a self-contained Node app. No build step. Keep it that way.

## Run

```bash
node server.mjs            # port 8787
node --test test/*.test.mjs          # real Chromium; ~20 s
node bench/bench.mjs       # latency + bytes
```

The token is at `data/token` (never commit it). Chromium is found by
`resolveChromePath()` — system paths first, then the Playwright cache; override
with `IW_CHROME`.

## Invariants

1. **One intent per call.** Batch actions; return the post-batch observation.
2. **Hot paths use direct CDP** (`session.cdpEval`), not Playwright evaluate.
   Playwright is for lifecycle, frames, navigation and trusted input fallbacks.
3. **Refs are verified before use.** If an element's tag/role/label changed,
   fail with `stale`; never click a guess.
4. **Timers are extrapolated only across a normal frame gap.** A stalled timer
   is `idle`, not still ticking.
5. **The page SDK is injected as text** (`src/page-sdk.js`) and must stay
   dependency-free; it runs in every frame, including cross-origin ones.
6. **No public bind without a token.** The token is the security boundary.

## Files

- `server.mjs` — routes, auth, SSE, screencast, static.
- `src/browser.mjs` — Fleet/Session, CDP hot paths, frames, act steps.
- `src/page-sdk.js` — `iw.snap/pulse/reflex/...` (in-page).
- `src/mcp.mjs` — MCP tools; keep tool names intent-shaped.
- `public/` — the human browser window at `/` and the diagnostics UI at `/console`; vanilla JS, no framework.
- `fixtures/` — deterministic pages for tests and demos.
- `deploy/` — Docker + Cloudflare notes (deployment itself needs owner approval).

## Measure before claiming

`bench/bench.mjs` writes `bench/results/*.json`. Report loadavg with the numbers;
this box is shared. Any speed claim needs an artifact.
