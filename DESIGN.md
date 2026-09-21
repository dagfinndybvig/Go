# Design

Detailed design notes for *Jev Go*, a 9x9 Go game whose White stones are
played by [Jev](https://www.typesafe.ai), TypeSafe AI's "System One"
decision model.

## Overview

The player is Black; the machine is White. White is always driven by
Jev — there is no fallback to the local heuristic. A built-in local
heuristic drives Black in autoplay mode, so you can watch Jev's
decisions against a greedy captures-and-liberties baseline. The local
heuristic is deliberately kept simple — no sequence reading, no
territory estimation — as a baseline for comparison.

This design is inspired by, and follows the architecture of,
[*Fight*](https://github.com/dagfinndybvig/Fight) — a one-on-one karate
game in the same Arcade collection whose AI opponent is also driven by
Jev. The Jev integration pattern (local CORS proxy, state text, `Choice`
question, argmax move selection) and the autoplay and log-panel concepts
originate there; this repo adapts them to Go's turn-based flow. Unlike
Fight, Jev plays its best move here (argmax over the distribution)
rather than a temperature-sampled one, and there is no heuristic
fallback — Jev always plays White.

### Why Jev is weak at Go

Jev is a general-purpose decision model, not a dedicated Go engine. It
receives a text description of the board and returns one move per turn
— no search tree, no Monte Carlo playouts, no learned board evaluation.
Dedicated Go AI (AlphaGo and its successors) needed deep neural
networks trained on millions of self-play games plus tree search to
reach human level; Jev has none of that machinery.

In practice, Jev's Go play shows three patterns:

- **Tactical awareness without strategy.** Jev finds captures and atari
  saves well — these are described in the move criteria and map to
  clear local reasoning. But it does not build territory, form eye
  shape, or plan group safety beyond the immediate move.
- **Reactive mirroring.** In quiet positions Jev tends to play directly
  adjacent to the opponent's last move, creating contact fights rather
  than claiming open space. On 9x9, where every point matters, this lets
  the heuristic build territory unchallenged.
- **Low confidence.** Average confidence per move is around 0.30, with
  many moves at 0.05–0.15. Jev itself is uncertain in most positions;
  high-confidence picks are almost always captures or atari saves.

The state text includes a territory estimate and group-in-danger scan
to help Jev see the strategic picture, and passing is discouraged while
open points remain. But there is a ceiling on how much prompt context
can compensate for a model that does not deeply understand Go.

The local heuristic is also deliberately weak — one-ply greedy, no
sequence reading, no life-and-death — so the two AIs are comparable in
strength. Autoplay is a baseline AI benchmark: two limited approaches
playing the same game, each showing what it can and cannot do.

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
- Row 1 (y=0) is at the bottom of the canvas, row 9 (y=8) at the top —
  standard Go orientation, matching the text board Jev sees. The click
  handler inverts y accordingly: `y = (N-1) - round(...)`.
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

White's moves are always chosen by Jev — a typed decision model that
returns choices with probability distributions instead of generating
text. There is no fallback to the local heuristic.

- **Endpoint**: `POST /jev` (proxied) or `POST
  https://api.typesafe.ai/v1/systemone` (direct)
- **Model**: `jev-latest`
- **Question**: one `Choice` question named `move`
- **Fetch timeout**: 10s via `AbortController`
- **Retry**: on error or timeout, `jevMove` retries up to 3 times (1s
  between attempts). If all retries fail, an error message is shown and
  no move is played — the game waits.

#### State sent to Jev

`buildState()` assembles a compact text description:

- The rules context (9x9, area scoring, komi 5.5, two passes end the
  game).
- Captures so far for both sides.
- The board as text: rows 9 (top) down to 1, columns A–J (no I, as in
  traditional Go notation), `X` = White, `O` = Black, `.` = empty.
- The opponent's last move and Jev's own previous move (so it can avoid
  repeating).
- **Territory estimate**: a rough area score for both sides (stones +
  surrounded empty regions + komi), with a "you are ahead / behind /
  even" judgment. This gives Jev urgency to fight for territory when it
  is losing, and to consolidate when it is winning.
- **Groups in danger**: a list of all groups (both colors) with 1–2
  liberties, with their coordinates and liberty count. This lets Jev
  see threats before choosing a move.
- The number of candidate moves and strategic guidance: save groups in
  atari first, capture or attack weak opponent groups, keep groups
  connected, avoid getting surrounded, and do not pass while there are
  still open points on the board.

#### Move filtering

When there are more than 30 legal moves, `filterMoves()` reduces the
options to the 30 most relevant ones before sending them to Jev:

- Captures always included (priority 1000).
- Moves near existing stones (Manhattan distance ≤ 2) get priority
  (bonus 100).
- Center bias (bonus up to 10 by Manhattan distance to center).
- Slight randomness for variety (bonus 0–5).

This focuses Jev on tactically meaningful moves instead of presenting
70+ generic options where most are described as "open point".

#### Choice criteria

Each candidate move is a criterion, keyed by its coordinate (`E5`),
with a tactical annotation computed from the resulting position:

- `captures N stone(s)` — how many stones the move takes
- `saves your group at X from atari (now N liberties)` — rescues a
  friendly group that was in atari before the move
- `puts an opponent group in atari` — leaves an enemy group with one
  liberty
- `reduces an opponent group to 2 liberties` — threatens an enemy group
- `self-atari (1 liberty after move)` / `unsafe (2 liberties after
  move)` / `3 liberties after move` / `N liberties after move` — always
  reported so Jev can judge safety of every move
- `extends your group` — connects to a friendly group
- `contact with enemy` — adjacent to an enemy stone
- `edge point` / `open point` — fallback annotation for quiet moves

Plus one extra criterion, `pass`. When the board still has more than 3
empty points, the pass criterion is annotated as "not recommended"
with a warning that passing gives the opponent a free move. Only when
the board is nearly settled (≤3 empty points) is pass described
neutrally, so Jev can end the game.

#### Move selection

Jev plays optimally: the game picks the highest-probability legal option
from the returned distribution (argmax), not a random sample. One
filter applies first: options that are not legal moves (or `pass`) are
dropped. If probabilities are missing, Jev's top pick is used as is.
There is no temperature and no randomness — the same position always
gets the same move.

#### Error handling

There is no heuristic fallback. If Jev is unavailable:

- No API key: the HUD shows "WHITE: JEV (NO KEY)" and the status line
  says "Jev API key required — press J to enter a key." No move is
  played.
- Timeout (10s) or network error: `jevMove` retries up to 3 times with
  1s between attempts. If all retries fail, an error message is shown
  and the game waits — it does not substitute the heuristic.
- Illegal choice: retried up to 3 times, then an error message is shown.

Every error is logged with its reason; every successful decision is
logged with both Jev's original pick and the played pick.

## When you can play against Jev

Jev's availability depends entirely on how the game is served, because
the TypeSafe API does not send CORS headers:

| How you open the game | Jev? | Why |
| --- | --- | --- |
| `file://` (double-click `jev-go.html`) | No, until you enter a key | The game tries the API directly; browsers block cross-origin calls from `file://`. White does not move until you press `J` and enter a key — there is no heuristic fallback. |
| `http://localhost:3000` (`node server.js`) | Yes, if a key exists | The proxy forwards `POST /jev` server-side. The server injects `TYPESAFE_API_KEY` from its environment; a browser key entered with `J` also works and takes precedence. |
| Hosted (GitHub Pages) | No, until you enter a key | There is no proxy on Pages, so `/jev` returns 404. White does not move — there is no heuristic fallback. Press `J` and enter a key to enable Jev directly against the API (CORS permitting). |

The HUD in the bottom-right corner reflects this at all times:

- **green `WHITE: JEV`** — Jev is enabled and choosing White's moves
- **red `WHITE: JEV (NO KEY)`** — no API key set; White is waiting

`GET /jevstatus` reports `{ serverKey: true/false }`; the game polls it
once at startup to enable Jev without a browser key.

## Autoplay modes

There are two play modes, toggled with **0**:

### Manual mode (default)

You click to place Black stones; White is Jev. Pass and Undo work.
Clicks during White's turn or after game over are ignored. Without an
API key, White does not move — press `J` to enter one.

### Autoplay mode

Jev (White) plays against the local heuristic (Black) with no human
input:

- Each side moves on a ~700ms cadence (`AUTO_DELAY`).
- When the game ends, the result stays on screen for 4 seconds, then a
  new game starts automatically — the comparison runs continuously.
- The score line and game-over message name the AIs instead of "you":
  **Local AI** (Black) vs **Jev** (White). Labels are computed by one
  `labels()` function (no parameters — White is always Jev) so the
  pair is always consistent.
- Pass and Undo are disabled; clicks are ignored.
- Toggling autoplay **off** mid-game returns control immediately: you
  play Black from the current position, and the normal manual flow
  resumes.
- Autoplay requires an API key; without one, White does not move.

**What autoplay actually compares depends on hosting** — this is the
subtle part:

| Hosting | Autoplay is |
| --- | --- |
| `localhost:3000` with a key | Jev vs local heuristic — the real comparison |
| `localhost:3000` without a key | Jev vs local heuristic, but White stalls (no key) |
| GitHub Pages or `file://` | Same — White stalls until a key is entered |

So the Jev-vs-heuristic comparison is only meaningful when the game is
served by `server.js` with `TYPESAFE_API_KEY` set (or a key entered with
`J`).

## HUD and logging

- **Matchup line** (under the title, yellow, large): exactly who is
  playing who, with stone glyphs — `● You (Black) vs ○ Jev (White)` or
  `● Local AI (Black) vs ○ Jev (White)` in autoplay. White is always
  Jev.
- **Game-over overlay** (across the board): when the game ends, the
  result — winner and score — appears in large red letters on a dark
  panel over the board. It is cleared by New game, Undo, or the
  autoplay restart.
- **Controls row**: Pass, Undo, New game, plus buttons for the mode
  options — `Autoplay: off/on (0)`, `API key (J)`, `Jev log (L)`. Every
  keyboard shortcut has a visible button equivalent.
- **Player combinations panel** (under the score, bordered): the
  matchups — you vs Jev (needs an API key), or local AI vs Jev
  (autoplay) — and the keys/buttons that switch them.
- **Status line** (top): whose turn it is, what Jev is doing, illegal
  move reasons, retry status, and the game result with both scores.
- **Score line**: captures for both sides with stone glyphs, labeled
  "● You (Black)" or "● Local AI (Black)" depending on mode.
- **`WHITE: JEV` / `WHITE: JEV (NO KEY)`** (bottom-right): whether Jev
  is enabled. Green when active, red when no key is set.
- **`AUTOPLAY (0 to toggle)`** (bottom-left, yellow): autoplay is on.
- **Jev log panel** (`L`, bottom-left): the last 10 decisions in reverse
  order — timestamp, played point, confidence, and Jev's original pick
  when the argmax overrode it; errors are shown with their reason.
- **Console**: `window.jevLog()` returns the full 200-entry ring buffer;
  `window.jevClear()` empties it. Log entries carry `{ t, ok, choice,
  jevChoice, confidence, state, probabilities, reason }`.

## Architecture

```
index.html    — redirect to jev-go.html (GitHub Pages serves index.html at the root)
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

**Mid-game failure**: if the server dies while a game is open, Jev
polls fail and White stops moving — the HUD turns red and shows "NO
KEY". The game retries up to 3 times (10s timeout per attempt) before
showing an error message; it does not substitute the heuristic. Once
the server is back, Jev resumes automatically on White's next turn,
provided the server had a key when the page was loaded (`serverKey` is
detected once at startup). If the page was loaded while the server was
down, reload the page after starting the server, or press `J` and
enter a key.

### Constants

| Constant | Value | Purpose |
| --- | --- | --- |
| `N` | 9 | Board size |
| `MARGIN` | 30 px | Grid inset on the canvas |
| `CELL` | 51 px | Intersection spacing ((468 − 60) / 8) |
| `AUTO_DELAY` | 700 ms | Pause between autoplay moves |
| `MAX_OPTIONS` | 30 | Max candidate moves sent to Jev |
| `LOG_MAX` | 200 | Jev decision ring-buffer size |
| fetch timeout | 10000 ms | Jev poll timeout via `AbortController` |
| retry limit | 3 | Retries on error/timeout before giving up |
| komi | 5.5 | Points added to White's area score |
