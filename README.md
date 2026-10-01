<img width="790" height="764" alt="go" src="https://github.com/user-attachments/assets/135e689e-840d-4afd-97c7-015f69b51834" />

# Jev Go

A small 9x9 Go game that supports **both local models through
[Ollama](https://ollama.com) and online API [TypeSafe Jev](https://www.typesafe.ai)**.
You play Black; the selected decision model plays White. Without either
backend, White uses a built-in local heuristic. Autoplay lets the local
heuristic play Black against White.

**Originally developed with TypeSafe.** The game, its prompts, mechanical
facts, and scoring experiments were developed using TypeSafe's Jev
"System One" API. The published development benchmarks and replay below
come from that TypeSafe work—not from Nimble or another Ollama model.
TypeSafe remains fully supported as the original backend.

**Accessible local option:** Ollama support was added so the project can
also be tried without a TypeSafe account or API key, on hardware capable
of running the selected model. Install **[Ollama](https://ollama.com) 0.35.0
or newer (required)**, run
`ollama pull nimble:latest`, create the 16K `nimble-go` variant in
[OLLAMA.md](OLLAMA.md), then start the server with that model. No API
key is needed, requests stay local, and the server uses Ollama's native
decision endpoint. To use the original cloud backend instead, follow the
TypeSafe setup in [Running](#running).

Jev is a general-purpose decision model, not a dedicated Go engine. The
TypeSafe policy scores each legal move and combines those scores with a
move-choice prior and a separate pass judgment. Ollama uses a lighter
Choice tournament and pass judgment. Neither uses tree search or playouts,
so the game compensates with mechanical
facts computed by the rules engine: each candidate move's exact capture
and liberty consequences, ladder-capture warnings, snapback trade
counts, and whether ataried Black groups can escape. Over the full
historical local-anchor benchmark (160 games), the scored build beat the greedy
heuristic 26-14 (65%, seed-paired sign test p = 0.0044) and beats
noisier anchors by more. That run predates the simple-ko fix
(commit `174139f`); the benchmark section notes a post-fix
confirmation that preserves the headline. The local opponent is still deliberately weak
(greedy captures and liberties, no sequence reading), so autoplay is a
baseline comparison rather than a strong Go exhibition. See the
approach, replay, and benchmark summary below, and [DESIGN.md](DESIGN.md)
for the experiment history and per-seed results.

Historical benchmark results below were obtained with **TypeSafe Jev**,
including both the early Choice-only and later scored policies—not the
current Ollama Choice/Noul tournament. They also predate the
player-relative komi correction; rerun before using them as ratings for
the current build.

A short recap of the rules of Go, with links for learning more, is in
[GO_RULES.md](GO_RULES.md).

## Ollama and TypeSafe at a glance

Ollama is the local runtime, not a model name. The local example here is
**Nimble** (`nimble-go`, a 16K-context configuration of `nimble`); the
original cloud model is **TypeSafe Jev**.

| | Ollama with Nimble | TypeSafe Jev |
|---|---|---|
| Role in this project | Accessible local option, added after the original development | Original development and benchmark backend |
| Requirements | Ollama 0.35.0 or newer, model download, suitable local hardware; no API key | TypeSafe API key and network access; inference runs remotely |
| Default move policy | Choice tournament over all legal actions plus a Noul pass gate | Per-action Scores plus a Choice prior and Noul pass gate |
| Published development benchmarks | Not Nimble results | Obtained using TypeSafe Jev; model releases and configurations are recorded below |
| What can be concluded | Supported and playable locally; no established strength rating here | Historical evidence for the tested Jev policies, not a general Go rank |

The default policies differ, so a direct comparison of their normal
autoplay games mixes model and decision-method effects. A fair model
comparison should use the same positions, prompts, legal actions, and
decision method on both backends.

### Quick matched model comparison

On **2026-10-01**, a small probe compared local Nimble
(`nimble-go:latest`) with TypeSafe Jev (resolved to `jev-1.13.0`).
Both used the same **Choice/Noul tournament**, board facts, and complete
legal action list—no per-move Scores on either backend.

| Position, White to move | Nimble move / elapsed | TypeSafe Jev move / elapsed |
|---|---|---|
| Opening after Black E5 | G5 / 1.72s | B5 / 0.62s |
| Black D4 can be captured at D5 | D5 / 1.55s | D5 / 0.63s |
| Seeded 21-ply position | B2 / 1.96s | D2 / 0.56s |

Both found the one-stone capture at D5. They disagreed on the other two
moves; without an independent evaluation, disagreement is not evidence
that one move was better. TypeSafe was faster in this sample (mean
0.60s versus 1.74s), but these are single-trial machine/network timings,
not a controlled performance benchmark or strength rating. This probe
also differs from TypeSafe's normal scored policy.
See [method and fixtures](BENCHMARK.md#quick-matched-model-comparison).

## The takeaway

Dagfinn Dybvig started a naive attempt to let Jev play Go without any special training or programming. Lukas Mosser's rebuild — per-move
Scores plus a Choice prior plus a Noul pass gate — underlies the recorded
scoring experiments below. The current Ollama path instead uses a
Choice/Noul tournament for latency. The
mechanical-facts generation of the final version made it stronger by supplying what Jev
cannot compute (captures, liberties, ladders, snapback) and
withholding what it should judge for itself. The paired,
color-balanced benchmark Lukas also built is the instrument that
benchmarked the project as it grew.

## How it evolved

The original TypeSafe-backed game went through three generations, each
measured against the previous one:

1. **First version** (`main` branch, through commit `0d24bc2`): Jev
   received a board description with a territory estimate, strengthened
   anti-pass language, and 1-ply lookahead annotations in each move
   description. Measured against the local greedy heuristic in
   autoplay, it lost all three games — the heuristic captured every
   stone.
2. **Lukas Mosser's rebuild** (commits `a510643`–`aef43a7`, from
   [his fork's main branch](https://github.com/LukasMosser/Go)): stripped
   the prompt to the compact board plus the complete legal move list,
   added per-move `Score` outputs with a `Choice` prior and a `Noul`
   pass gate, and built the retained paired color-balanced benchmark
   runner with Elo estimates and opponent anchors (including a KataGo
   human-SL profile). In his ten-game comparison the compact
   Choice-only prompt lost 0/10 while candidate scoring won 9/10 —
   see the [first benchmark section](#benchmark) below.
3. **Mechanical facts** (commits `9354e3b`–`7fd71a1`, this branch):
   added rules-engine-computed facts to the state — weak-group scan,
   capture threats, ladder warnings, snapback trade counts, and
   Black-group fate reports — each step measured with paired
   color-balanced games, and finished with the full local-anchor
   standard: 160 games with paired significance tests. Jev beats all
   four anchors; see the [second benchmark section](#benchmark-mechanical-facts-and-the-full-anchor-pool)
   below. KataGo judged none of these steps — it was not installed on
   the measurement machine at first, so every fact was kept or dropped on local
   anchors alone; the [external evaluation](#benchmark-against-katago)
   came after the generation was finished, and put the gains in
   perspective: 1-19 against KataGo's 5-kyu profile, so the facts
   generation's improvements are relative, not absolute.

The lesson running through all three generations: give Jev what it
cannot compute itself (mechanical consequences, group status), withhold
what it should judge itself (style directives, position verdicts).

The game is also served from GitHub Pages:
**https://dagfinndybvig.github.io/Go/** — decision AI needs the local
server (see Running below). On Pages (or when opening
`jev-go.html` directly without a server) the game tries the TypeSafe
API directly with your browser key, but the API sends no CORS headers,
so the browser blocks the call. To use Ollama or TypeSafe Jev, run
`node server.js` locally. Without a backend, White is played by the local
heuristic AI instead.

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
| Set TypeSafe Jev API key | `J` |
| Toggle Jev log panel | `L` |
| Toggle autoplay (decision model vs local AI) | `0` |

All of these are also visible as buttons above the board: **Autoplay:
off/on (0)**, **TypeSafe key (J)**, and **Jev log (L)**.

## Running

**Without a server (local AI plays White):** open `jev-go.html` directly
in a browser. No build step or external assets are required.

**With local Ollama (no API key):** install **Ollama 0.35.0 or newer**,
pull a decision model such as `nimble:latest`, then run:

```
node server.js
```

With no TypeSafe key, the first installed model with a sufficiently
large context is auto-detected. For Nimble, create the 16K `nimble-go`
variant described in [OLLAMA.md](OLLAMA.md), then set
`OLLAMA_MODEL=nimble-go` to select it explicitly. See
[OLLAMA.md](OLLAMA.md) for setup, native/chat modes, remote hosts, and
benchmarking.

**With TypeSafe Jev:** run the same server, then open
**http://localhost:3000**. The server reads
`TYPESAFE_API_KEY` or `TYPESAFEAI_API_KEY` from its environment or the
game folder's `.env` file (check `GET /jevstatus`); you can also press
**J** in-game and paste a key from
[console.typesafe.ai](https://console.typesafe.ai). A browser key always
takes precedence on the TypeSafe path and is stored in `localStorage`.
An explicit `OLLAMA_MODEL` takes precedence over TypeSafe.

**Environment variable:**

```
# macOS / Linux
TYPESAFE_API_KEY=yourkey node server.js

# Windows (cmd.exe)
set "TYPESAFE_API_KEY=yourkey" && node server.js

# Windows (PowerShell)
$env:TYPESAFE_API_KEY="yourkey"; node server.js
```

For a local `.env` file, put either `TYPESAFE_API_KEY=yourkey` or
`TYPESAFEAI_API_KEY=yourkey` in the game folder. Hidden files are not
served by the local web server.

The HUD shows who is playing at all times:

- A prominent **backend indicator** under the title: amber for discovery,
  configuration not yet verified, or a request in progress; green for
  `last decision succeeded`; red for backend errors or the local fallback.
  The model name is shown, but configuration alone never means connected.
- A yellow **matchup line** under the title with stone glyphs, e.g.
  `● You (Black)  vs  ○ Ollama (White)` or
  `● You (Black)  vs  ○ Jev (White)`,
  `● You (Black)  vs  ○ Local AI (White)` (no backend),
  `● Local AI (Black)  vs  ○ Ollama/Jev (White)` (autoplay), or
  `● Local AI 1 (Black)  vs  ○ Local AI 2 (White)` (autoplay without a backend),
  naming the actual driver of each colour.
- A bordered **player combinations** panel listing the possible
  matchups and how to switch between them.
- The indicator in the bottom-right corner:

- **WHITE: OLLAMA model (version, mode)** or **WHITE: JEV** — the selected
  decision backend; green after success, amber before verification or
  during a request, red on error
- **red WHITE: LOCAL AI** — no backend is configured; the local
  heuristic is playing White

After you place Black, the status line says White is thinking, without a
timer. When White finishes it reports the coordinate, for example
`Ollama played B7 — your move.` Backend errors
include the upstream HTTP detail instead of only a status number.

### Starting, stopping, restarting the server

**Start** — from the game folder:

```
cd C:\Users\dybvig\Arcade\Go
node server.js
```

It prints a banner, the game URL, and the selected Ollama, TypeSafe, or
local-heuristic backend. The game is then at **http://localhost:3000**.

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

**Network access** — the server binds to `127.0.0.1` only, so neither
the game nor the `/jev` proxy (which spends your server-side API key) is
reachable from the local network. To open the game from another device
on your network, start it deliberately exposed:

```
# macOS / Linux
HOST=0.0.0.0 node server.js

# Windows (cmd.exe)
set "HOST=0.0.0.0" && node server.js

# Windows (PowerShell)
$env:HOST="0.0.0.0"; node server.js
```

The startup banner prints the address it is listening on. The proxy
also refuses `/jev` request bodies over 256 KB with HTTP `413` (real
Jev requests are tens of KB), so oversized uploads cannot exhaust
memory. TypeSafe upstream calls are bounded at 15 seconds and Ollama
calls at 30 seconds; an unresponsive request returns HTTP `504` instead
of remaining open indefinitely.

**If the server stops mid-game** — decision requests fail and the game
retries up to 3 times before showing an error; White waits rather than
falling back to the heuristic. Once the server is running again, the
backend resumes automatically on White's next turn. If the page was
loaded while the server was down, reload it after starting the server.
Starting a new game or using **Undo** cancels delayed White moves and
in-flight requests as well as invalidating old responses. Only one White
decision can run per position. Backend discovery must complete before
White can fall back to the local heuristic; discovery errors are not
treated as proof that no backend exists.

## How it works

On every White turn, the game sends one typed JSON request
through the local server. It goes to TypeSafe System One (`jev-latest`)
or Ollama `/v1/systemone`. The `state` string
contains the compact board (`O` black, `X` white, `.` empty), captures,
pass count, last moves, komi, and a coordinate legend. Columns are
`A B C D E F G H J` (Go omits I); rows are numbered 1–9 from bottom to
top. It also lists every legal point's exact immediate rules-engine
effects: which Black stones it captures and how many liberties White's
resulting connected group has. When the played group would be left in
atari, or in atari-after-extension that a ladder captures, the point's
line carries a mechanical warning; when the move captures stones and
the played group is still left with one liberty, the line states both
counts (the snapback trade). Moves that atari or ladder-catch a Black
group report whether Black can save it ("cannot extend", "caught in a
ladder even if Black extends", "can escape by extending"). A mechanical
facts block follows the board: groups with 3 or fewer liberties (both
colors) and capture threats — which White stones Black could capture on
their reply. The legal move set is complete (up to 81
points) plus `pass`.

The request always asks for two typed outputs:

- `move` is a `Choice` over every legal coordinate and `pass`. Option
  names are coordinates, and their descriptions are `null`.
- `pass_ok` is a `Noul` judgment on whether passing is strategically
  sound.

For TypeSafe, the request additionally asks for one
`quality_<coordinate>` `Score` per candidate, including `quality_pass`,
using the 0–4 rubric major blunder, poor, playable, good, excellent.
Interactive Ollama play omits those 82 repeated Score questions and
plays the highest-probability allowed finalist after applying the Noul
pass gate. Above 26 options, the adapter evaluates all actions in balanced
groups of 2–26, then compares group winners in a final Choice.
Probabilities describe that final comparison, not a synthetic global
distribution. The tournament is an approximation and can depend on
grouping. It is shared with the Ollama benchmark.

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

For TypeSafe, an empty 9×9 board produces at most 84 outputs: one
`Choice`, one `Noul`, and 82 `Score` fields (81 points plus pass). The
game selects the candidate maximizing

```text
score + 0.05 × ln(max(choice_probability, 1e-9))
```

The TypeSafe `Score` is the main value estimate; the log-probability term gives
the `Choice` a small prior. `pass` enters that comparison only when the
`Noul` probability for “passing is strategically sound” is at least 0.5.
Ollama instead takes the final Choice argmax after applying the same
pass gate. The selected move is deterministic. Network errors, timeouts,
HTTP 408/429, and 5xx errors retry up to three times; other HTTP 4xx errors
are shown immediately. Without Ollama or a TypeSafe key, White uses the
local heuristic.

### Replay

This TypeSafe Jev recording displays the board and the per-point score heat
map side by side. Placed stones are shown on the board and set their
heat-map positions to zero; open points show the score-plus-log-prior
value with interpolation between intersections. The pass probability is
shown above the boards.

<video controls preload="metadata" width="100%">
  <source src="./jev-game-replay.mp4" type="video/mp4">
  Your browser does not support embedded video. [Open the MP4](jev-game-replay.mp4).
</video>

### Benchmark

Using TypeSafe Jev, Lukas's paired headless benchmark compared the earlier compact
`Choice`-only prompt against this multi-output candidate scorer. Both
cohorts used the same reconstructed harness, game rules, local Black
heuristic, terminal scoring, 600-turn limit, random seeds 1–10, and Jev
model release `jev-1.13.0`.

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

### Benchmark: mechanical facts and the full anchor pool

These are TypeSafe Jev results, not Ollama/Nimble measurements.

Since that comparison, the state gained mechanical facts computed by the
rules engine — weak-group scan, capture threats, ladder warnings,
snapback trade counts, and Black-group fate reports. Each step was
measured with paired, color-balanced games (see
[DESIGN.md](DESIGN.md) for every table). The consistent pattern: facts
help, one-sided style directives hurt both ways, and verdicts about the
position hurt most. The facts trade a little raw win rate for the
near-elimination of catastrophic collapses (worst loss −86.5 → −18.5
over 20-game runs).

The current build then ran the full local-anchor standard: 20
color-balanced pairs against each of `greedy`, `noise25`, `noise50`,
and `random` — 160 games, `jev-1.13.0`. The runner reports exact
two-sided sign tests, including a seed-paired test that counts each
Jev-Black + Jev-White pair by the sign of its combined margin, which
cancels the color advantage.

| Anchor | Jev W-D-L | Score rate | Elo Δ [95% approx] | Mean margin | Seed-paired p |
| --- | ---: | ---: | ---: | ---: | ---: |
| local-greedy | 26-0-14 | 65.0% | +108 [−3 to 219] | +17.6 | 0.0044 |
| greedy + 25% random | 30-0-10 | 75.0% | +191 [69 to 313] | +37.4 | 0.0004 |
| greedy + 50% random | 35-0-5 | 87.5% | +338 [181 to 495] | +54.5 | <0.0001 |
| uniform random | 40-0-0 | 100.0% | +∞ [407 to ∞] | +81.0 | <0.0001 |

Against `greedy` the raw record alone (p = 0.081) is indistinguishable
from a coin flip at 40 games; the color-balanced pairs (16-3) resolve
it. These are local-anchor ratings for this 9x9 ruleset, not human or
19x19 Go strength. See
[the full-anchor section](DESIGN.md#full-anchor-benchmark-with-paired-significance-tests)
and [BENCHMARK.md](BENCHMARK.md).

**Timing caveat** — this 160-game run predates the simple-ko fix
(commit `174139f`): that engine did not block immediate ko
recaptures, so its games were played without the simple ko rule the
docs described. A post-fix confirmation run (10 pairs vs `greedy`,
seeds 1-10, same `jev-1.13.0`) scored 16-0-4 with seed-paired
p = 0.0039, so the headline result holds under the corrected rules.
The table above is kept as originally measured; the other anchors have
not been re-run post-fix.

### Benchmark against KataGo

This evaluation used TypeSafe Jev against the KataGo anchor.

[KataGo](https://github.com/lightvector/KataGo) is the strongest
open-source Go engine — at full strength it plays far above any human.
It also ships a *human-SL* model: a network trained to imitate human
play, which can be pinned to a labeled rank. The runner pins it to
`rank_5k`, roughly a 5-kyu human, driven over GTP at one visit and
full temperature — the configuration KataGo documents for imitating a
rank profile. Lukas built this anchor into the benchmark runner
(commit `aef43a7`), and it is the one opponent not defined by this
repo's own heuristics: the local anchors only say "better or worse
than the greedy heuristic," while the `rank_5k` profile is an external
reference point of approximate human strength. It is a model-labeled
profile, not a calibrated Elo — see the caveats in
[BENCHMARK.md](BENCHMARK.md).

In the project's evolution KataGo played three roles. Lukas Mosser
defined it as an anchor in generation 2 and used it once, as a two-game
pilot
(−28.5, −53.5) that validated the engine integration and color swap.
It judged nothing in generation 3: every mechanical-facts variant was
kept or dropped on local anchors alone. And after generation 3 and the
simple-ko fix, it delivered the external evaluation the local pool
cannot: Jev lost 1-19 (mean margin −32.5), meaning the facts
generation's gains over greedy are relative — the build still loses
decisively to a profile labeled 5 kyu. That is also why the ko fix
mattered for this anchor specifically: KataGo is the only opponent
whose own engine would have rejected a ko recapture, so the claimed
rules parity was false until commit `174139f`.

On macOS, install KataGo and download its human-SL model once:

```sh
brew install katago
mkdir -p ~/.local/share/katago/models
curl -fL 'https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz' \
  -o ~/.local/share/katago/models/b18c384nbt-humanv0.bin.gz
```

On Windows, download the CPU (Eigen) build and the human-SL model once (the
zip ships `katago.exe`, its DLLs, and `gtp_human5k_example.cfg`):

```sh
mkdir -p ~/.local/share/katago/bin ~/.local/share/katago/models
curl -fL -o ~/.local/share/katago/katago-eigen.zip 'https://github.com/lightvector/KataGo/releases/download/v1.15.0/katago-v1.15.0-eigen-windows-x64.zip'
curl -fL -o ~/.local/share/katago/models/b18c384nbt-humanv0.bin.gz 'https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz'
powershell -NoProfile -Command "Expand-Archive ~/.local/share/katago/katago-eigen.zip -DestinationPath ~/.local/share/katago/bin -Force"
```

Homebrew auto-discovery does not exist on Windows, so pass the paths
explicitly:

```sh
node benchmark.js --pairs 10 --opponents katago-5k \
  --katago-bin ~/.local/share/katago/bin/katago.exe \
  --katago-model ~/.local/share/katago/models/b18c384nbt-humanv0.bin.gz \
  --katago-human-model ~/.local/share/katago/models/b18c384nbt-humanv0.bin.gz \
  --katago-config ~/.local/share/katago/bin/gtp_human5k_example.cfg
```

With `TYPESAFE_API_KEY` in the environment or the repository's `.env`, run ten
color-swapped pairs (20 games) against KataGo's `rank_5k` human-SL profile:

```sh
node benchmark.js --pairs 10 --opponents katago-5k
```

To run the same benchmark through Ollama's native decision endpoint,
add `--ollama-model nimble:latest`; see
[OLLAMA.md](OLLAMA.md#benchmarking).

The runner uses the installed Homebrew model/config, 9×9, 5.5 komi, Chinese
rules, one visit, and temperature 1. Results go to an ignored JSONL file and
include model hashes and per-game color/results; a sibling `.traces.jsonl`
file records every position, Jev's per-candidate scores, and the terminal
area ownership map. See [the benchmark guide](BENCHMARK.md)
for alternate opponents, path overrides, and rating caveats.

Result (Windows, 10 pairs, seeds 1-10, 20 games, `jev-1.13.0` vs KataGo
v1.15.0): Jev lost 1-19, mean margin −32.5, seed-paired 0-10; the one win
came as White (+5.5), and every game ended in two passes. The `rank_5k`
profile is decisively stronger than Jev — the expected external
calibration point, played under identical rules on both sides (simple ko
is enforced since commit `174139f`).

Press **L** in-game to watch the decisions live. In the browser console,
`window.jevLog()` returns the last 200 decisions and `window.jevClear()`
empties the log.

## Autoplay mode

Press **0** to toggle autoplay: the active decision model (White) plays
against the local heuristic AI (Black), with no human input. Each side moves on a ~700ms
cadence, and when the game ends the result appears in large red letters
across the board for a few seconds before a new game starts
automatically. The score line and game-over message name the AIs
instead of "you" — **Local AI** (Black) vs **Ollama** or **Jev**
(White). Without a decision backend, autoplay is local AI vs local AI.

Toggling autoplay off mid-game returns control: you play Black from
whatever position the board is in. Pass and Undo are disabled while
autoplay runs.

## Architecture

```
jev-go.html   — entire game (single file, no dependencies)
server.js     — local Node.js server + Ollama/TypeSafe decision proxy
benchmark.js  — paired Ollama/TypeSafe rating runner
ollama-decision.js — shared validation, batching, and Choice tournament
OLLAMA.md     — recommended local-model setup and protocol guide
index.html    — redirect to jev-go.html, so GitHub Pages serves the game
```

The game logic (groups, liberties, captures, ko, scoring) is pure
functions over a 9x9 array; the Ollama-first Jev-compatible integration
mirrors the pattern used in [Fight](https://github.com/dagfinndybvig/Fight).

## Credits

The generation 2 rebuild — the multi-output move scoring (a `Score` per
candidate plus a `Choice` prior and a `Noul` pass gate), the compact
prompt, the color-balanced benchmark runner with its opponent anchors
including the KataGo human-SL profile — was designed and implemented by
[Lukas Mosser](https://github.com/LukasMosser) in
[his fork](https://github.com/LukasMosser/Go) (commits `a510643`–`aef43a7`).
Every later result in this repository is built inside his architecture,
and his benchmark is the instrument that measured them — including the
ones that outperformed his own build. The first naive version (generation
1) was built by [Dagfinn Dybvig](https://github.com/dagfinndybvig).
