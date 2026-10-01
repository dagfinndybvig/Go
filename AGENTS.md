# AGENTS.md

Notes for coding agents working in this repo. Read this before editing.

## What this is

A 9x9 Go game (`jev-go.html`, single file, no dependencies) whose White
stones are played by a local Ollama decision model (recommended) or
TypeSafe Jev, with a local greedy heuristic when neither backend exists. A
local greedy heuristic drives Black in autoplay mode. `server.js` is a
zero-dependency Ollama/TypeSafe proxy. `benchmark.js` runs paired,
color-balanced rating matches against fixed opponent anchors. See
OLLAMA.md for local-model setup, DESIGN.md for architecture, and
README.md for usage.

## Gotchas

### CRLF vs LF (the big one)

The repo blobs are LF, but `core.autocrlf=true` means any `git
checkout` / `git rebase` / `git stash pop` leaves the working copy
CRLF. After that, edit-tool `old_string` matching silently fails with
"not found" because the file now has `\r\n` while your string has `\n`.

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
- Functions inside the Jev IIFE (`blackGroupFate`, `ladderCaptured`,
  `buildEvaluationState`, `coordName`) are not top-level either. Expose
  them by injecting a line before the IIFE's return anchor:
  `script.replace('return {\n    chooseMove,', 'globalThis.__jev = { blackGroupFate, ladderCaptured, buildEvaluationState, coordName };\n  return {\n    chooseMove,')`.
- The script needs `location` in the sandbox (`location.hostname`), and
  `draw()` calls every canvas 2d method — stub `getContext` with a
  Proxy that returns no-op functions.
- The DOM stub does not parse HTML. Static markup (e.g. the modes panel
  text) is invisible to tests — only assert on what JS writes via
  `textContent`.
- Timing: `/jevstatus` resolves asynchronously (sleep ~50ms before
  asserting `Jev.isEnabled()`), and White's move fires after a 350ms
  `setTimeout` (sleep ~600ms+ after a Black move). Jev's fetch uses a
  10s `AbortController` timeout — polyfill `AbortController` in the vm
  context when testing `Jev.chooseMove`.
- The heuristic has random tie-breaking (`Math.random() * 2` in the
  score). Never assert a specific move choice — assert stone counts.
- Jev mocks: any probabilities work — the game plays the argmax over
  legal options (deterministic, no temperature sampling).
- Jev receives the complete legal move list. On a 9x9 board there are at
  most 81 legal points, plus the `pass` option. When mocking
  `Jev.chooseMove`, criteria include every legal point plus `pass`.
- `labels()` takes no parameters — White is always Jev.
- Delete test scripts when done; they are not committed.

### Shell quirks (Git Bash on Windows)

- The bash tool runs Git Bash (MINGW64), not cmd.exe/PowerShell. Windows
  paths fail: `cd C:\Users\...` errors with "No such file or directory".
  Use POSIX paths: `cd /c/Users/dybvig/Arcade/Go`.
- `$1`/`$2` inside double-quoted `node -e "..."` strings are expanded by
  bash to empty strings — regex replacements silently produce
  `getB()[][]`-style garbage. Use the edit tool for source changes, not
  shell one-liners.
- Unquoted URLs with parentheses (`Go_(game)`) are shell syntax errors —
  quote them.
- Do not print `TYPESAFE_API_KEY`; it is set in this environment.

### Server lifecycle

- `node server.js` serves on port 3000, bound to `127.0.0.1` by default
  so the LAN cannot reach the `/jev` proxy and spend the server key.
  `HOST=0.0.0.0 node server.js` deliberately exposes it — keep that an
  explicit opt-in, don't change the default. `/jev` bodies over 256 KB
  are refused with `413` (real requests are tens of KB). A second
  instance fails with `EADDRINUSE` — check `netstat -ano | findstr :3000`
  and kill the holder (`taskkill /F /PID <pid>`) before starting.
- Static files are read per request: `jev-go.html` changes need no
  restart; `server.js` changes do.
- Backend precedence is explicit `OLLAMA_MODEL`, then a TypeSafe key,
  then the first context-compatible Ollama model auto-detected from
  `/api/tags` plus `/api/show`. Native
  Ollama `/v1/systemone` is preferred; older versions use a generalized
  chat adapter that must return every requested typed field.
  `OLLAMA_HOST` supports HTTP and HTTPS.
- Ollama native limits are at most 64 questions and 26 candidates per
  Choice. Interactive Ollama play requests the complete Choice plus
  Noul, omitting exhaustive Scores for latency. The server and benchmark
  split/recombine large Choice distributions; never truncate the legal
  move list. Full benchmark requests use 44-question batches. Go's
  empty-board prompt is about
  8K tokens, so auto-detection prefers models configured with
  `num_ctx >= 16384`. The stock `nimble:latest` context is only 8194 and
  can return HTTP 400 on dense positions; use a 16K `nimble-go` variant.
  Browser/server Ollama timeouts are 30s; TypeSafe
  keeps its 10s/15s limits.
- When testing the live API through the proxy, start the server with
  `tools.process.start` (background), not a foreground bash call — a
  foreground call blocks until timeout.

### GitHub Pages

- `index.html` is a redirect to `jev-go.html`. Without it, Pages renders
  README.md instead of the game. Do not delete it.
- Decision AI never runs on Pages: there is no Ollama proxy, and the
  TypeSafe API sends no CORS headers, so the browser blocks direct calls
  even with a browser key. Don't "fix" this by pointing the browser at
  either local Ollama or TypeSafe directly. The endpoint logic uses the proxy
  (`/jev`) only on `localhost`/`127.0.0.1`; everywhere else it goes
  direct to `https://api.typesafe.ai`, which the browser blocks. The
  on-screen text reflects this: the modes panel recommends local Ollama
  through `node server.js`, and errors on non-localhost say to run the
  server locally.
- The user pushes from the web UI and other sessions concurrently.
  Expect push rejections; `git fetch` + `git rebase origin/main`, then
  push. Never force-push without asking.
- Development happens directly on `main` — it is the working branch
  and the Pages source. `lukas-main` is an archive of the integrated
  fork work, kept for reference; do not commit there.

### Jev integration invariants

- `lastMove` holds the board snapshot from *before* the move just
  applied (for the ko check), not a coordinate and not the move's result
  board — the result equals the current board during the next turn,
  which makes `isKo` a permanent no-op. (This exact bug shipped once and
  was fixed; don't reintroduce it.) `lastCoord` is the display/state-text
  coordinate. Keep both updated in `applyMove` and `doPass`;
  `benchmark.js` mirrors the same semantics in `playGame`.
- White is the selected decision backend (Ollama or TypeSafe) when one
  is available. Without a backend, White falls back to the local
  heuristic. There is no fallback on low confidence or errors:
  `jevMove` retries up to 3 times (10s timeout per attempt); if all
  retries fail it shows an error message and does not play a move. The
  HUD (`setHud`), score line, and matchup line show "Ollama", "Jev", or
  "Local AI" for White. `labels()` takes no parameters and checks the
  selected backend internally.
- `chooseMove` receives every legal move. The Choice criteria contain
  every legal point plus `pass`; `buildState` supplies the compact board
  and coordinate legend, and the argmax considers the full legal set.
- Jev's Choice criteria use each legal point's coordinate as the option
  name and `null` as its description; `pass` is also a null-described
  option. The compact state carries the board, game metadata, and an
  explicit coordinate legend. Candidate facts add exact capture and
  resulting-liberty annotations to the state. Ollama interactive play
  uses Choice plus a Noul pass gate; TypeSafe also requests one Score per
  legal point/pass.
- Mechanical facts are rules-engine output only — no evaluative
  language. Per candidate point: a warning when the played group is
  left with 1 liberty ("Black captures/recaptures the group (N stones)
  next turn"; the recapture variant states both counts so Jev judges
  the snapback trade), a warning when 2 liberties and
  `ladderCaptured()` says the ladder dies, and a Black-group fate
  report from `blackGroupFate()` ("cannot extend (White captures it
  next turn)" / "caught in a ladder even if Black extends" / "can
  escape by extending") for Black groups reduced to <=2 liberties.
  `blackGroupFate` simulates Black's saving extension and withholds a
  claim when the extension gains 3+ liberties; fate facts are
  suppressed when the played White group is itself in atari. Keep new
  facts mechanical — one-sided directives and position verdicts
  measurably hurt (see DESIGN.md). A bounded liberty-race chase
  ("caught in a liberty race even if Black extends") was tested over 40
  paired games and changed nothing (seed-paired 14-5 both, loss
  profile worse); it was reverted — don't re-add it without new
  evidence.

- The benchmark runner keeps Jev player-relative: when Jev plays actual
  Black, the benchmark swaps board colors and capture counts before asking
  the same White-oriented prompt. Keep color-swapped games paired by seed,
  and record the resolved model version and anchor name for every game.
  The summary reports exact two-sided sign tests per opponent: a
  per-game test on the win/loss record and a stricter seed-paired test
  (each pair counted by the sign of its combined margin, which cancels
  the color advantage). Judge prompt variants by the seed-paired
  p-value, not raw win rates.
- Benchmark Ollama mode rewrites both retained policy request paths to
  `<OLLAMA_HOST>/v1/systemone`, replaces only the model name, and never
  sends a TypeSafe authorization header. It requires native mode; do not
  compare chat-adapter synthetic probabilities with native benchmarks.

- For the optional KataGo anchor, `genmove` advances KataGo's GTP board itself;
  only send GTP `play` commands for Jev's moves. Reset board size, komi, rules,
  and `rank_5k` parameters at each paired game. KataGo Chinese rules match this
  app's simple ko, area scoring, and suicide-illegal behavior.
