<img width="790" height="764" alt="go" src="https://github.com/user-attachments/assets/135e689e-840d-4afd-97c7-015f69b51834" />

# Jev Go

A small 9x9 Go game where the White stones are played by
[Jev](https://www.typesafe.ai), TypeSafe AI's "System One" decision model.
You play Black against Jev. In autoplay mode, a built-in local heuristic
AI plays Black against Jev's White.

A short recap of the rules of Go, with links for learning more, is in
[GO_RULES.md](GO_RULES.md).

The game is also served from GitHub Pages:
**https://dagfinndybvig.github.io/Go/** — Jev needs the local proxy
server and an API key (see Running below), so on Pages (or when opening
`jev-go.html` directly without a server) White will not move until you
press J and enter a key.

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

All of these are also visible as buttons above the board: **Autoplay:
off/on (0)**, **API key (J)**, and **Jev log (L)**.

## Running

**Without a server (White does not move):** open `jev-go.html` directly in
a browser. No build step, no external assets. White will not move
until you press **J** and enter an API key — there is no local-AI
fallback for White.

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

The HUD shows who is playing at all times:

- A yellow **matchup line** under the title with stone glyphs, e.g.
  `● You (Black)  vs  ○ Jev (White)` or
  `● Local AI (Black)  vs  ○ Jev (White)` (autoplay), naming the
  actual driver of each colour.
- A bordered **player combinations** panel listing the possible
  matchups and how to switch between them.
- The indicator in the bottom-right corner:

- **green WHITE: JEV** — Jev is active and choosing White's moves
- **red WHITE: JEV (NO KEY)** — no API key set; press J to enter one

### Starting, stopping, restarting the server

**Start** — from the game folder:

```
cd C:\Users\dybvig\Arcade\Go
node server.js
```

It prints a banner, the game URL, and whether a server-side key was
found. The game is then at **http://localhost:3000**.

**Stop** — press `Ctrl+C` in the terminal running it. If it runs in the
background with no terminal, kill the process holding port 3000:

```
# Windows (cmd.exe / PowerShell)
netstat -ano | findstr :3000
taskkill /F /PID <pid>

# macOS / Linux
lsof -ti :3000 | xargs kill
```

**Restart** — stop it, then start it again. Two things worth knowing:

- Changes to `jev-go.html` do **not** need a restart — static files are
  read from disk on every request, so a browser refresh picks them up.
- Changes to `server.js` **do** need a restart.

**Port already in use** — if startup fails with
`Error: listen EADDRINUSE: address already in use :::3000`, a previous
instance is still running. Stop it with the commands above, then start
again.

**If the server stops mid-game** — Jev polls fail and White stops
moving (the HUD turns red and shows "NO KEY"). The game retries up to
3 times before showing an error. Once the server is running again, Jev
resumes automatically on White's next turn — no page reload needed, as
long as the server had a key when the page was loaded. If the page was
loaded while the server was down, either reload the page after starting
the server, or press `J` and enter a key.

## How it works

On each White turn:

1. **State** — the game builds a text description: the board diagram,
   captures, both players' last moves, komi, and a list of all groups
   with 1-2 liberties ("Groups in danger") so Jev sees threats.
2. **Filter** — when there are more than 30 legal moves, the game
   selects the 30 most relevant: captures, atari saves, moves near
   existing stones, and center bias. This focuses Jev on tactically
   meaningful options instead of 70+ generic "open point" choices.
3. **Question** — a single `Choice` question is POSTed to the TypeSafe
   System One API (model `jev-latest`) through the local proxy: one
   option per candidate move, each annotated with its tactical effects
   (captures, saves from atari, atari threats, resulting group
   liberties, group extensions, enemy contact), plus a `pass` option.
4. **Decision** — Jev returns the chosen point, a probability
   distribution over all options, and a confidence score. No text
   generation — one typed round trip per turn.
5. **Pick** — the game plays the highest-probability legal option from
   the distribution: Jev's best move, with no randomness.
6. **Retry** — on timeout (10s) or error, the game retries up to 3
   times before showing an error message. Jev always plays White — no
   fallback to the local heuristic.

```
board state + group threats → text → filter to 30 candidates
            → POST /jev → choice + probabilities + confidence
            → argmax over legal options → White plays
```

Press **L** in-game to watch the decisions live. In the browser console,
`window.jevLog()` returns the last 200 decisions and `window.jevClear()`
empties the log.

## Autoplay mode

Press **0** to toggle autoplay: Jev (White) plays against the local
heuristic AI (Black), with no human input. Each side moves on a ~700ms
cadence, and when the game ends the result appears in large red letters
across the board for a few seconds before a new game starts
automatically. The score line and game-over message name the AIs
instead of "you" — **Local AI** (Black) vs **Jev** (White) — so you
can watch Jev's best moves against the greedy heuristic's
captures-and-liberties play. Autoplay requires an API key; without one,
White does not move.

Toggling autoplay off mid-game returns control: you play Black from
whatever position the board is in. Pass and Undo are disabled while
autoplay runs.

## Architecture

```
jev-go.html   — entire game (single file, no dependencies)
server.js     — local Node.js server + Jev CORS proxy (run: node server.js)
index.html    — redirect to jev-go.html, so GitHub Pages serves the game
```

The game logic (groups, liberties, captures, ko, scoring) is pure
functions over a 9x9 array; the Jev integration mirrors the pattern used
in [Fight](https://github.com/dagfinndybvig/Fight).
