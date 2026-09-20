# Jev Go

A small 9x9 Go game where the White stones are played by
[Jev](https://www.typesafe.ai), TypeSafe AI's "System One" decision model.
You play Black against either Jev or a built-in local heuristic AI.

## Rules

Full Go rules on a 9x9 board: captures, suicide prevention, and simple ko.
Two consecutive passes end the game; area scoring (stones + surrounded
territory) with komi 5.5 for White. Territory is marked on the board at
game end.

## Controls

| Action | Input |
| --- | --- |
| Place a stone | Click an intersection |
| Pass | Pass button (two passes end the game) |
| Undo | Undo button (returns to your turn) |
| New game | New game button |
| Set Jev API key | `J` |
| Toggle Jev log panel | `L` |
| Toggle autoplay (Jev vs local AI) | `0` |

## Running

**Without Jev (local AI only):** open `jev-go.html` directly in a browser.
No build step, no external assets.

**With Jev AI:** the TypeSafe API does not send CORS headers, so
browser-to-API calls are blocked. A zero-dependency Node.js proxy server
is included. Run it locally:

```
node server.js
```

Then open **http://localhost:3000** in your browser. The server picks up
`TYPESAFE_API_KEY` from its environment automatically (check
`GET /jevstatus`); you can also press **J** in-game and paste a key from
[console.typesafe.ai](https://console.typesafe.ai). A browser key always
takes precedence. The key is stored in `localStorage`.

**Environment variable:**

```
# macOS / Linux
TYPESAFE_API_KEY=yourkey node server.js

# Windows (cmd.exe)
set TYPESAFE_API_KEY=yourkey && node server.js

# Windows (PowerShell)
$env:TYPESAFE_API_KEY="yourkey"; node server.js
```

The HUD in the bottom-right corner shows the AI status:

- **green JEV** — Jev is active and choosing White's moves
- **red LOCAL AI** — fallback to the built-in heuristic (no key, network
  error, timeout, confidence below 0.3, or an illegal choice)

## How it works

On each White turn:

1. **State** — the game builds a text description: the board diagram,
   captures, both players' last moves, and komi.
2. **Question** — a single `Choice` question is POSTed to the TypeSafe
   System One API (model `jev-latest`) through the local proxy: one
   option per legal move, each annotated with its tactical features
   (captures, atari, self-atari risk), plus a `pass` option.
3. **Decision** — Jev returns the chosen point, a probability
   distribution over all options, and a confidence score. No text
   generation — one typed round trip per turn.
4. **Sampling** — the game samples from the distribution with a random
   temperature (1.6–2.4) and never repeats the previous move, so play is
   varied rather than deterministic.
5. **Fallback** — on timeout (3s), error, low confidence (< 0.3), or an
   illegal pick, White switches to the built-in heuristic AI.

```
board state → text → POST /jev → choice + probabilities + confidence
            → temperature sample → White plays
```

Press **L** in-game to watch the decisions live. In the browser console,
`window.jevLog()` returns the last 200 decisions and `window.jevClear()`
empties the log.

## Autoplay mode

Press **0** to toggle autoplay: Jev (White) plays against the local
heuristic AI (Black), with no human input. Each side moves on a ~700ms
cadence, and when the game ends the result is shown for a few seconds
before a new game starts automatically. The score line and game-over
message name the local AI instead of "you", so you can watch the two
approaches compete — Jev's sampled decisions against the greedy
heuristic's captures-and-liberties play.

Toggling autoplay off mid-game returns control: you play Black from
whatever position the board is in. Pass and Undo are disabled while
autoplay runs.

## Architecture

```
jev-go.html   — entire game (single file, no dependencies)
server.js     — local Node.js server + Jev CORS proxy (run: node server.js)
```

The game logic (groups, liberties, captures, ko, scoring) is pure
functions over a 9x9 array; the Jev integration mirrors the pattern used
in [Fight](https://github.com/dagfinndybvig/Fight).
