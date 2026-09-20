# AGENTS.md

Notes for coding agents working in this repo. Read this before editing.

## What this is

A 9x9 Go game (`jev-go.html`, single file, no dependencies) whose White
stones are played by the TypeSafe "System One" decision model (Jev) when
an API key is available, with a local greedy heuristic as fallback.
`server.js` is a zero-dependency Node proxy that makes Jev work locally.
See DESIGN.md for architecture and README.md for usage.

## Gotchas

### CRLF vs LF (the big one)

The working copy is LF, but any `git checkout` / `git rebase` / `git
stash pop` converts files to CRLF (Windows `core.autocrlf`). After that,
edit-tool `old_string` matching silently fails with "not found" because
the file now has `\r\n` while your string has `\n`.

Fix: normalize before editing after any git operation that touches files:

```
node -e "const fs=require('fs');for(const f of ['jev-go.html','README.md','DESIGN.md']){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n'));}"
```

Expect this after every rebase — it has happened repeatedly in this repo.

### Board indexing

The board is `board[y][x]` — row first. Test fixtures that assume
`board[x][y]` will pass syntax checks and fail mysteriously. Coordinates
in the UI and Jev state text are `A-J` columns (no I, Go convention) and
1-9 rows, mapped by `coordName(x, y) = COLS[x] + (y + 1)`.

### Testing headlessly

There is no test framework. Tests are throwaway Node scripts using
`vm.runInContext` over the extracted `<script>` block. Known traps:

- Top-level `const`/`let` in the script do **not** become sandbox
  properties (only `function` declarations do). Append an export shim:
  `script + '\n;globalThis.__x = { humanPlay, getBoard: () => board };'`
  (getters for anything reassigned, like `board`).
- The DOM stub does not parse HTML. Static markup (e.g. the modes panel
  text) is invisible to tests — only assert on what JS writes via
  `textContent`.
- Timing: `/jevstatus` resolves asynchronously (sleep ~50ms before
  asserting `Jev.isEnabled()`), and White's move fires after a 350ms
  `setTimeout` (sleep ~600ms+ after a Black move).
- The heuristic has random tie-breaking (`Math.random() * 2` in the
  score). Never assert a specific move choice — assert stone counts.
- Jev mocks: use `probabilities: { CHOICE: 1.0 }`. Real-shaped
  distributions get temperature-sampled (1.6–2.4) and will flake.
- Delete test scripts when done; they are not committed.

### Shell quirks (Git Bash on Windows)

- `$1`/`$2` inside double-quoted `node -e "..."` strings are expanded by
  bash to empty strings — regex replacements silently produce
  `getB()[][]`-style garbage. Use the edit tool for source changes, not
  shell one-liners.
- Unquoted URLs with parentheses (`Go_(game)`) are shell syntax errors —
  quote them.
- Do not print `TYPESAFE_API_KEY`; it is set in this environment.

### Server lifecycle

- `node server.js` serves on port 3000. A second instance fails with
  `EADDRINUSE` — check `netstat -ano | findstr :3000` and kill the
  holder (`taskkill /F /PID <pid>`) before starting.
- Static files are read per request: `jev-go.html` changes need no
  restart; `server.js` changes do.
- When testing the live API through the proxy, start the server with
  `tools.process.start` (background), not a foreground bash call — a
  foreground call blocks until timeout.

### GitHub Pages

- `index.html` is a redirect to `jev-go.html`. Without it, Pages renders
  README.md instead of the game. Do not delete it.
- Jev never runs on Pages (no proxy; `/jev` 404s) — White falls back to
  the heuristic there. Don't "fix" this by pointing the browser at the
  API directly; CORS blocks it. Local-only Jev is the accepted design.
- The user pushes from the web UI and other sessions concurrently.
  Expect push rejections; `git fetch` + `git rebase origin/main`, then
  push. Never force-push without asking.

### Jev integration invariants

- `lastMove` holds a full board snapshot (for the ko check), not a
  coordinate. `lastCoord` is the display/state-text coordinate. Keep
  both updated in `applyMove` and `doPass`.
- White's driver is reflected in three places that must agree: the HUD
  (`setHud`), the score line, and the matchup line — all driven by
  `whiteIsJev`. Status texts must name the actual driver
  (`Jev.isEnabled()` for the *upcoming* move, `whiteIsJev` for the move
  just played), never hardcode "Jev".
- The fallback chain (no key, timeout 3s, HTTP error, confidence < 0.3,
  illegal choice) must always land on `heuristicPick` — the game must
  never stall or crash when Jev is unreachable.
