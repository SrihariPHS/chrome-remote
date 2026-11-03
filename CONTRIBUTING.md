# Contributing

Small, direct patches are welcome.

```bash
npm install
npx playwright install chromium     # only if you have no Chrome/Chromium
npm test                            # 11 end-to-end tests against real Chromium
npm run bench                       # latency + bytes, writes bench/results/
```

## Where things live

| file | what belongs there |
| --- | --- |
| `server.mjs` | routes, auth, WebSocket screencast, static files |
| `src/browser.mjs` | `Fleet` and `Session`: launch, contexts, CDP hot paths, tabs |
| `src/page-sdk.js` | the injected `iw` object — everything that runs inside the page |
| `src/mcp.mjs` | MCP tools; keep them intent-shaped, not click-shaped |
| `public/` | the human window and the console. Vanilla JS, no build step |

## Rules of thumb

- **One intent per call.** If a feature would make an agent call the server twice
  where once would do, it belongs in the batch or in the page.
- **Keep the human page free of diagnostics.** Metrics, ref trees and timelines go to
  `/console`.
- **No build step.** `public/` is served as written.
- **Don't add a dependency** unless it replaces a lot of code. Today: `ws` and
  `playwright-core`.
- New UI behaviour needs a screenshot in the pull request; new API behaviour needs a
  test in `test/e2e.test.mjs`.

## Reporting bugs

Include the output of `GET /health`, the operation name, and whether the page is
ordinary HTML or a canvas/iframe-heavy app. A `snap`/`pulse` dump is worth more than
a description.
