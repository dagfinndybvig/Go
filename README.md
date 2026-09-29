<img width="790" height="764" alt="go" src="https://github.com/user-attachments/assets/135e689e-840d-4afd-97c7-015f69b51834" />

# Jev Go

A small 9x9 Go game where the White stones are played by
[Jev](https://www.typesafe.ai), TypeSafe AI's "System One" decision
model, when an API key is available. Without a key, White falls back to
a built-in local heuristic AI. You play Black. In autoplay mode, the
local heuristic drives Black against Jev's White (or against itself if
no key is set).

Jev is a general-purpose decision model, not a dedicated Go engine. The
current experiment asks it to score each legal move and combines those
scores with a move-choice prior and a separate pass judgment. It still
does no tree search or playouts, and its move evaluation can miss tactical
sequences: in the ten-game benchmark it won nine games, but one tactical
failure let Black capture 41 stones. The local opponent is also deliberately
weak (greedy captures and liberties, no sequence reading), so autoplay is a
baseline comparison rather than a strong Go exhibition. See the approach,
replay, and benchmark summary below, and [DESIGN.md](DESIGN.md) for the
experiment history and per-seed results.

A short recap of the rules of Go, with links for learning more, is in
[GO_RULES.md](GO_RULES.md).

The game is also served from GitHub Pages:
**https://dagfinndybvig.github.io/Go/** — Jev needs the local proxy
server and an API key (see Running below). On Pages (or when opening
`jev-go.html` directly without a server) the game tries the TypeSafe
API directly with your browser key, but the API sends no CORS headers,
so the browser blocks the call. To play against Jev, run `node server.js`
locally. Without a key (on Pages, file://, or localhost without a key),
White is played by the local heuristic AI instead — the game still works,
just without Jev.

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

**Without a server (local AI plays White):** open `jev-go.html` directly in
a browser. No build step, no external assets. Without an API key, White
is played by the local heuristic AI — the game works, just without Jev.

**With Jev AI:** the TypeSafe API does not send CORS headers, so
browser-to-API calls are blocked. A zero-dependency Node.js proxy server
is included. Run it locally:

```
node server.js
```

Then open **http://localhost:3000** in your browser. The server reads
`TYPESAFE_API_KEY` or `TYPESAFEAI_API_KEY` from its environment or the
game folder's `.env` file (check `GET /jevstatus`); you can also press
**J** in-game and paste a key from
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

For a local `.env` file, put either `TYPESAFE_API_KEY=yourkey` or
`TYPESAFEAI_API_KEY=yourkey` in the game folder. Hidden files are not
served by the local web server.

The HUD shows who is playing at all times:

- A yellow **matchup line** under the title with stone glyphs, e.g.
  `● You (Black)  vs  ○ Jev (White)`,
  `● You (Black)  vs  ○ Local AI (White)` (no key),
  `● Local AI (Black)  vs  ○ Jev (White)` (autoplay with key), or
  `● Local AI 1 (Black)  vs  ○ Local AI 2 (White)` (autoplay without key),
  naming the actual driver of each colour.
- A bordered **player combinations** panel listing the possible
  matchups and how to switch between them.
- The indicator in the bottom-right corner:

- **green WHITE: JEV** — Jev is active and choosing White's moves
- **red WHITE: LOCAL AI** — no API key set; the local heuristic is
  playing White. Press J to enter a key (Jev needs `node server.js` on
  localhost).

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

**If the server stops mid-game** — Jev's move requests fail and the
game retries up to 3 times before showing an error; White waits rather
than falling back to the heuristic (the HUD keeps showing
`WHITE: JEV` if a server key was detected at load). Once the server is
running again, Jev resumes automatically on White's next turn — no page
reload needed, as long as the server had a key when the page was
loaded. If the page was loaded while the server was down, either reload
the page after starting the server, or press `J` and enter a key.

## How it works

On every White turn, the game sends one JSON request to the TypeSafe
System One API (`jev-latest`) through the local proxy. The `state` string
contains the compact board (`O` black, `X` white, `.` empty), captures,
pass count, last moves, komi, and a coordinate legend. Columns are
`A B C D E F G H J` (Go omits I); rows are numbered 1–9 from bottom to
top. It also lists every legal point's exact immediate rules-engine
effects: which Black stones it captures and how many liberties White's
resulting connected group has. The legal move set is complete (up to 81
points) plus `pass`.

The request's `questions` object asks for three kinds of typed output:

- `move` is a `Choice` over every legal coordinate and `pass`. Option
  names are coordinates, and their descriptions are `null`.
- `pass_ok` is a `Noul` judgment on whether passing is strategically
  sound.
- Each `quality_<coordinate>` field is a `Score` for that candidate,
  including `quality_pass`. Its shared rubric is 0–4: major blunder,
  poor, playable, good, excellent.

Here is the JSON shape (the state text and move list are abbreviated; the
live request expands them to the current position and every legal move):

```json
{
  "model": "jev-latest",
  "state": "[board, game metadata, coordinate legend, and candidate outcomes]",
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "Choose White’s strongest legal point. Save groups in atari, capture opponent groups, build territory, and keep groups connected. Pass only when the position is settled; two consecutive passes end the game.",
      "criteria": { "A1": null, "B2": null, "pass": null }
    },
    "pass_ok": {
      "type": "noul",
      "instructions": "Is passing now a strategically sound move for White?",
      "criteria": {
        "true": "The position is settled or no meaningful White play remains; passing is preferable to playing a harmful or unnecessary move.",
        "false": "There is still a useful point to play, a group to save, a capture to make, or territory to build or reduce."
      }
    },
    "quality_A1": {
      "type": "score",
      "instructions": "Rate White’s move A1 using the shared move-quality scale.",
      "criteria": ["Major blunder", "Poor", "Playable", "Good", "Excellent"]
    },
    "quality_B2": {
      "type": "score",
      "instructions": "Rate White’s move B2 using the shared move-quality scale.",
      "criteria": ["Major blunder", "Poor", "Playable", "Good", "Excellent"]
    },
    "quality_pass": {
      "type": "score",
      "instructions": "Rate White’s move pass using the shared move-quality scale.",
      "criteria": ["Major blunder", "Poor", "Playable", "Good", "Excellent"]
    }
  }
}
```

An empty 9×9 board produces at most 84 outputs: one `Choice`, one
`Noul`, and 82 `Score` fields (81 points plus pass). Jev provides a
numeric score for each candidate and a probability for each `Choice`
option. The game selects the candidate maximizing

```text
score + 0.05 × ln(max(choice_probability, 1e-9))
```

The `Score` is the main value estimate; the log-probability term gives
the `Choice` a small prior. `pass` enters that comparison only when the
`Noul` probability for “passing is strategically sound” is at least 0.5.
The selected move is deterministic. The browser retries API errors or
timeouts up to three times; without an API key, White uses the local
heuristic.

### Replay

This recorded game displays the board and the per-point Jev score heat
map side by side. Placed stones are shown on the board and set their
heat-map positions to zero; open points show the score-plus-log-prior
value with interpolation between intersections. The pass probability is
shown above the boards.

<video controls preload="metadata" width="100%">
  <source src="./jev-game-replay.mp4" type="video/mp4">
  Your browser does not support embedded video. [Open the MP4](jev-game-replay.mp4).
</video>

### Benchmark

The paired headless benchmark compared the earlier compact `Choice`-only
prompt against this multi-output candidate scorer. Both cohorts used the
same reconstructed harness, game rules, local Black heuristic, terminal
scoring, 600-turn limit, random seeds 1–10, and Jev model release
`jev-1.13.0`.

| Approach | Jev wins | Average turns | Jev passes / API calls | Input tokens | Output tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Compact `Choice` only | 0/10 | 159.0 | 753 / 759 | 582,407 | 270,863 |
| Candidate `Score` + `Choice` prior + `Noul` pass gate | 9/10 | 86.9 | 30 / 432 | 1,703,197 | 414,574 |

The mean final score margin from White's perspective changed from −75.5
to +1.8 points (median +5.0). The candidate scorer's one loss was a
clear tactical failure: Black won 66–20.5 after capturing 41 stones.
The evaluation cost more: about 2.9× the total input tokens and 5.1× the
input tokens per API call. This is an exploratory ten-game result against
a weak local baseline, not evidence of general Go strength. See the
[full per-seed table and experiment notes](DESIGN.md#ten-game-paired-comparison)
for details and limitations. The color-balanced Elo runner and opponent
anchor definitions are documented in [BENCHMARK.md](BENCHMARK.md).

### Benchmark against KataGo

On macOS, install KataGo and download its human-SL model once:

```sh
brew install katago
mkdir -p ~/.local/share/katago/models
curl -fL 'https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz' \
  -o ~/.local/share/katago/models/b18c384nbt-humanv0.bin.gz
```

With `TYPESAFE_API_KEY` in the environment or the repository's `.env`, run ten
color-swapped pairs (20 games) against KataGo's `rank_5k` human-SL profile:

```sh
node benchmark.js --pairs 10 --opponents katago-5k
```

The runner uses the installed Homebrew model/config, 9×9, 5.5 komi, Chinese
rules, one visit, and temperature 1. Results go to an ignored JSONL file and
include model hashes and per-game color/results. See [the benchmark guide](BENCHMARK.md)
for alternate opponents, path overrides, and rating caveats.

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
captures-and-liberties play. Without an API key, autoplay is local AI vs
local AI — both sides use the heuristic.

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
