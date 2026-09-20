# Design

Detailed design notes for *Jev Go*, a 9x9 Go game whose White stones are
played by [Jev](https://www.typesafe.ai), TypeSafe AI's "System One"
decision model.

## Overview

The player is Black; the machine is White. White is driven by Jev when a
TypeSafe API key is available, and by a built-in local heuristic
otherwise. The local heuristic is deliberately kept simple — it serves
as the fallback when Jev is unavailable and as Jev's opponent in
autoplay mode, so the two approaches can be compared directly.

## Rules implementation

The board is a 9x9 array, `board[y][x]`, with `EMPTY = 0`, `BLACK = 1`,
`WHITE = 2`. All rules are pure functions over that array — no game
state lives in the DOM.

### Groups and liberties

`groupAndLiberties(bd, x, y)` flood-fills the group containing a stone
and counts its liberties (adjacent empty points, deduplicated). This is
the primitive everything else uses: captures, suicide detection, atari
annotation, and the heuristic's liberty scoring.

### Move legality

`tryMove(bd, x, y, color)` works on a copy of the board:

1. The point must be empty.
2. Place the stone, then remove any adjacent opponent group with zero
   liberties (captures).
3. If the placed stone's own group then has zero liberties, the move is
   suicide — illegal.

Returns `{ legal, board, captured }`; the returned board is the
post-capture position, which becomes the new game state when the move is
accepted.

### Ko

`isKo(prevBoard, nextBoard)` compares two positions point by point. A
candidate move is ko-illegal if its resulting board is identical to the
position as it stood before the opponent's last move — the standard
simple-ko rule, implemented as a one-deep positional check. `lastMove`
holds a full board snapshot (not a coordinate) precisely so this
comparison is possible; `legalMoves(bd, color, koBoard)` filters ko
violations the same way when enumerating moves for the AIs.

### Passing and game end

Two consecutive passes end the game. `passes` resets to 0 on any played
move. `doPass(color)` records the pass in history, and on the second
consecutive pass calls `endGame()`.

### Scoring

`endGame()` uses area scoring:

- Stones on the board count for their color.
- Each empty region is flood-filled; if it touches only one color, the
  whole region is that color's territory. Regions touching both colors
  (dame) count for nobody.
- White receives komi 5.5.

Territory is marked on the board with small dots at game end, so the
result is visible without reading the status line.

## Rendering

Everything is drawn on a single 468x468 canvas — no assets.

- Wooden board background (`#dcb35c`), 9x9 grid lines, and the five
  hoshi (star) points of a 9x9 board.
- Stones are circles at intersections, radius 0.46 cells; black stones
  get a dark outline, white stones a light grey one.
- At game end, territory points are marked with small dots in the
  owner's color.
- The last-move coordinate is tracked separately (`lastCoord`) for the
  Jev state text; it is not drawn.

## Game flow

The game is event-driven, not a render loop: moves are triggered by
clicks, button presses, and `setTimeout` scheduling between turns.

```
manual mode:
  click -> humanPlay (Black) -> applyMove -> jevMove (White)
        -> applyMove -> "Your move."

autoplay mode (0):
  blackAutoMove (local AI, Black) -> applyMove -> jevMove (Jev, White)
                ^                                            |
                +--------------------------------------------+
```

`applyMove(m, color)` is the single choke point for playing a move: it
pushes the previous state onto the undo history, applies the board,
updates captures and the ko snapshot, switches the turn, redraws, and
schedules the opponent's next move (350ms after a human move, 700ms
`AUTO_DELAY` between autoplay moves).

### Undo

`undo()` pops one state from the history and returns to the human's
turn. It is disabled in autoplay mode, where there is no human to return
control to.

## AI

### Local heuristic AI

`heuristicPick(moves, color)` is a one-ply greedy evaluator, generic in
color so it can drive either side. For each legal move it computes:

```
score = captured * 100
      - opponentBestReplyCapture * 80
      + ownLibertiesAfterMove * 4
      - manhattanDistanceToCenter
      + random * 2        (tie-break variety)
```

`opponentBestReplyCapture` enumerates the opponent's legal moves on the
resulting board and takes their best capture — a shallow "don't hand
them a capture" term. The move passes if the best move captures nothing
and still scores below -40, which happens when the board is nearly full
and every remaining move is self-destructive.

**Known limitations** (kept intentionally, as the baseline Jev is
compared against): no sequence reading (ladders, snapbacks), no
territory or influence estimation, no life-and-death judgment, no
concept of eye shape. It plays legal, plausible-looking moves at roughly
beginner strength.

### Jev AI (TypeSafe System One)

When enabled, White's moves are chosen by Jev — a typed decision model
that returns choices with probability distributions instead of
generating text.

- **Endpoint**: `POST /jev` (proxied) or `POST
  https://api.typesafe.ai/v1/systemone` (direct)
- **Model**: `jev-latest`
- **Question**: one `Choice` question named `move`
- **Fetch timeout**: 3s via `AbortController`
- **Confidence floor**: 0.3 — below this, fall back to the heuristic

#### State sent to Jev

`buildState()` assembles a compact text description:

- The rules context (9x9, area scoring, komi 5.5, two passes end the
  game).
- Captures so far for both sides.
- The board as text: rows 9 (top) down to 1, columns A–J (no I, as in
  traditional Go notation), `X` = White, `O` = Black, `.` = empty.
- The opponent's last move and Jev's own previous move (so it can avoid
  repeating).
- The number of legal moves.

#### Choice criteria

Every legal move is a criterion, keyed by its coordinate (`E5`), with a
tactical annotation computed from the resulting position:

- `captures N stone(s)` — how many stones the move takes
- `puts an opponent group in atari` — leaves an enemy group with one
  liberty
- `self-atari risk` — leaves the played group with one liberty
- `edge point` / `open point` — fallback annotation for quiet moves

Plus one extra criterion, `pass`, so Jev can end the game when nothing
is worth playing.

#### Sampling

Jev's top pick is not used directly. The game samples from the full
probability distribution with a random temperature of 1.6–2.4 per poll
(`weight = probability^(1/temperature)`), which flattens the
distribution and produces natural variety. Two filters apply before
sampling: options that are not legal moves (or `pass`) are dropped, and
Jev's previous choice is excluded so no two consecutive identical
decisions occur. If probabilities are missing, the top pick is used as
is.

#### Fallback chain

White falls back to the local heuristic when:

- No API key is available (neither browser key nor server key).
- The fetch times out (3s) or errors (network, HTTP status, malformed
  response).
- Confidence is below 0.3.
- Jev's sampled choice is not a legal move (e.g. it named an occupied
  point).

Every fallback is logged with its reason; every successful decision is
logged with both Jev's original pick and the sampled pick.

## When you can play against Jev

Jev's availability depends entirely on how the game is served, because
the TypeSafe API does not send CORS headers:

| How you open the game | Jev? | Why |
| --- | --- | --- |
| `file://` (double-click `jev-go.html`) | Never | The game tries the API directly; browsers block cross-origin calls from `file://`, so every poll fails and White falls back to the heuristic. |
| `http://localhost:3000` (`node server.js`) | Yes, if a key exists | The proxy forwards `POST /jev` server-side. The server injects `TYPESAFE_API_KEY` from its environment; a browser key entered with `J` also works and takes precedence. |
| Hosted (GitHub Pages) | Never | There is no proxy on Pages, so `/jev` returns 404 and every poll falls back. Pressing `J` sets a key but cannot help — the request path itself does not exist. |

The HUD in the bottom-right corner reflects this at all times:

- **green `JEV`** — Jev is enabled and choosing White's moves
- **red `LOCAL AI`** — the heuristic is driving White (no key, network
  error, timeout, low confidence, or illegal choice)

`GET /jevstatus` reports `{ serverKey: true/false }`; the game polls it
once at startup to enable Jev without a browser key.

## Autoplay modes

There are two play modes, toggled with **0**:

### Manual mode (default)

You click to place Black stones; White is Jev (or the heuristic
fallback). Pass and Undo work. Clicks during White's turn or after game
over are ignored.

### Autoplay mode

Jev (White) plays against the local heuristic (Black) with no human
input:

- Each side moves on a ~700ms cadence (`AUTO_DELAY`).
- When the game ends, the result stays on screen for 4 seconds, then a
  new game starts automatically — the comparison runs continuously.
- The score line and game-over message name the *local AI* instead of
  "you", so the readout makes sense for a machine-vs-machine game.
- Pass and Undo are disabled; clicks are ignored.
- Toggling autoplay **off** mid-game returns control immediately: you
  play Black from the current position, and the normal manual flow
  resumes.

**What autoplay actually compares depends on hosting** — this is the
subtle part:

| Hosting | Autoplay is |
| --- | --- |
| `localhost:3000` with a key | Jev vs local heuristic — the real comparison |
| `localhost:3000` without a key | heuristic vs heuristic (White falls back) |
| GitHub Pages or `file://` | heuristic vs heuristic (Jev cannot run there) |

So the Jev-vs-heuristic comparison is only meaningful when the game is
served by `server.js` with `TYPESAFE_API_KEY` set (or a key entered with
`J`). On Pages, autoplay still demonstrates the game loop end to end,
but both players are the same heuristic.

## HUD and logging

- **Matchup line** (under the title, yellow): exactly who is playing who
  at any moment — `You (Black) vs Jev (White)`, `You (Black) vs Local AI
  (White)`, `Local AI (Black) vs Jev (White)`, or `Local AI (Black) vs
  Local AI (White)`. It updates whenever the mode changes or White's
  driver changes (e.g. a fallback mid-game).
- **Modes hint** (under the score): the possible player combinations and
  the keys that switch them (`0` autoplay, `J` API key, `L` log).
- **Status line** (top): whose turn it is, what Jev is doing, illegal
  move reasons, and the game result with both scores.
- **Score line**: captures for both sides, labeled "you (Black)" or
  "local AI (Black)" depending on mode.
- **`JEV` / `LOCAL AI`** (bottom-right): which AI is driving White.
- **`AUTOPLAY (0 to toggle)`** (bottom-left, yellow): autoplay is on.
- **Jev log panel** (`L`, bottom-left): the last 10 decisions in reverse
  order — timestamp, played point, confidence, and Jev's original pick
  when sampling overrode it; fallbacks are shown with their reason.
- **Console**: `window.jevLog()` returns the full 200-entry ring buffer;
  `window.jevClear()` empties it. Log entries carry `{ t, ok, choice,
  jevChoice, confidence, state, probabilities, reason }`.

## Architecture

```
jev-go.html   — entire game: rules, rendering, both AIs, UI (single file, no dependencies)
server.js     — local Node.js server + Jev CORS proxy (run: node server.js)
```

`server.js` serves the static game on port 3000 and proxies `POST /jev`
to `https://api.typesafe.ai/v1/systemone`, forwarding the browser's
`Authorization` header or injecting `Bearer TYPESAFE_API_KEY` when the
browser sent none (a browser key always wins). `GET /jevstatus` reports
whether a server-side key is present.

### Server lifecycle

**Starting**: `node server.js` from the game folder serves the game on
`http://localhost:3000` and prints whether a server-side key was found.

**Stopping**: `Ctrl+C` in the terminal, or — for a background instance —
kill the process holding port 3000 (`netstat -ano | findstr :3000` then
`taskkill /F /PID <pid>` on Windows; `lsof -ti :3000 | xargs kill` on
macOS/Linux). A second instance fails with `EADDRINUSE` until the first
is stopped.

**Restarting**: stop, then start. Static files are read from disk on
every request, so changes to `jev-go.html` need no restart — a browser
refresh picks them up. Changes to `server.js` require a restart.

**Mid-game failure**: if the server dies while a game is open, the page
keeps working — Jev polls fail and White falls back to the local
heuristic (HUD turns red). Once the server is back, Jev resumes
automatically on White's next turn, provided the server had a key when
the page was loaded (`serverKey` is detected once at startup). If the
page was loaded while the server was down, reload the page after
starting the server, or press `J` and enter a key.

### Constants

| Constant | Value | Purpose |
| --- | --- | --- |
| `N` | 9 | Board size |
| `MARGIN` | 30 px | Grid inset on the canvas |
| `CELL` | 51 px | Intersection spacing ((468 − 60) / 8) |
| `AUTO_DELAY` | 700 ms | Pause between autoplay moves |
| `CONFIDENCE_FLOOR` | 0.3 | Below this, Jev's answer is discarded |
| `LOG_MAX` | 200 | Jev decision ring-buffer size |
| fetch timeout | 3000 ms | Jev poll timeout via `AbortController` |
| temperature | 1.6–2.4 | Random per-poll sampling temperature |
| komi | 5.5 | Points added to White's area score |
