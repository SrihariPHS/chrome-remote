---
name: chrome
description: Drive chrome.inkwork.studio — a warm remote Chromium — whenever a task needs a browser: open a page, read it as refs, fill a form, click through an app, scrape a table, watch a countdown, or take over a logged-out browser session. Use instead of screenshot-per-step browser tools.
---

# chrome.inkwork.studio

A remote Chromium you drive with **one intent per call**. The server holds the
browser, the CDP session and a page-side SDK (`iw`); your job is to give it
whole intents, not single clicks.

- URL: `https://chrome.inkwork.studio` (local: `http://127.0.0.1:8787`)
- Auth: `Authorization: Bearer $IW_TOKEN` (`data/token` on the server)
- MCP: `https://chrome.inkwork.studio/mcp`
- Agent reference: `https://chrome.inkwork.studio/llms.txt`
- Console: `https://chrome.inkwork.studio/?token=…`

## The loop

1. **Open** — `chrome_open {url, name}`. Reuse the returned session id.
2. **Observe** — `chrome_snap {max:100}`. Read the `@e12` refs and the text.
3. **Act** — `chrome_act {steps:[…]}` with every step the intent needs. It
   returns the post-batch observation in the same call.
4. **Repeat** only when the next decision genuinely depends on the new state.

Do not screenshot unless the question is about layout, canvas or overlap.
Screenshots are ~10–30× the cost of a snapshot and carry no semantics.

## Steps

```json
{"click":"@e4"} | {"click":{"text":"Submit"}} | {"click":{"x":100,"y":220}}
{"fill":{"ref":"@e12","text":"Ada"}} | {"type":"text into the focused element"}
{"press":"Enter"} | {"key":"Control+A"}
{"scroll":{"dy":800}} | {"hover":"@e4"}
{"select":{"ref":"@e6","value":"blue"}} | {"check":"@e7"} | {"uncheck":"@e7"}
{"wait":120} | {"waitFor":{"text":"Saved","timeout_ms":4000}}
{"goto":"https://…"} | {"back":true} | {"reload":true}
{"eval":"return document.title"} | {"dialog":"accept"}
```

Any step can set `"optional":true`; a required failure stops the batch.
Use `"input":"dom"` on the act call for ~3–10× faster clicks (in-page). The
default `"cdp"` sends trusted mouse events — use it for canvas, file pickers,
and apps that reject synthetic clicks.

## Time-sensitive UI (Kahoot, quizzes, timers, scores)

Never poll from the model. Two tools:

- `chrome_pulse` → `{countdown:{est,rate,age,dir}, numbers, focus, dialogs,
  last_change_age_ms}`. `est` is seconds remaining at read time, extrapolated
  from an in-page sample. If the timer stopped, `dir` becomes `idle` and it is
  not extrapolated.
- `chrome_reflex {until, do, every_ms:8, timeout_ms}` → arms an in-page loop.
  When the predicate is true, the action runs immediately. The response has
  `reaction_ms` (usually single-digit ms). This is the only way to beat a
  countdown.

Example: answer a quiz when 1.5 s remain.

```json
{"until":"snap.countdown && snap.countdown.est < 1.5",
 "do":"iw.click({text:\"Mars\"})",
 "every_ms":8,
 "timeout_ms":12000}
```

Verify after with `chrome_pulse` (score/dialogue) or `chrome_eval`.

## Code mode

For anything repetitive, use `chrome_eval` with the in-page SDK. One call can
loop, filter and return structured data:

```js
const rows = [...document.querySelectorAll('table tr')]
  .slice(1).map(r => [...r.cells].map(c => c.innerText.trim()));
return { n: rows.length, rows: rows.slice(0, 20) };
```

`iw` has `snap`, `pulse`, `click`, `fill`, `select`, `check`, `waitFor`,
`reflex`, `read`, `find`, `logs`, `seq`. `iw.click` is synthetic; use act/`cdp`
when trust matters.

## Recipes

`quiz.state`, `quiz.answer`, `kahoot.join`, `doc.append`, `doc.read` (see
`/api/recipes`).
They are heuristics and return their evidence; check it before trusting a guess.

## Rules

- One call = one intent. If you are about to make a second call that is just
  "click the next thing", you should have batched it.
- Refs are stable for the life of the element; `stale` means the node was
  replaced — re-snap, do not guess coordinates.
- `waitFor` and `reflex` run inside the page. Use them instead of model-side
  polling.
- Close sessions you no longer need (`chrome_close`); each holds a context.
- The live console view lags; the pulse is the truth.
- Never print `IW_TOKEN`. It controls the browser.
