# 9x9 decision-model rating benchmark

`benchmark.js` runs paired games from the normal empty-board start using the
same rules and Jev-compatible move policy as `jev-go.html`. It can call a
local Ollama model directly or use TypeSafe Jev. Each pair reuses a seed
for two games and swaps which side the decision model plays. The seed
controls local-opponent randomness; outputs, backend, and resolved model
are recorded.

**Provenance:** the published development results in README.md and
DESIGN.md—the early Choice-only comparison, candidate scoring,
mechanical-facts experiments, local-anchor ratings, and KataGo
evaluation—were run with **TypeSafe Jev**. The project was developed
against that original backend. Ollama support was added later to make
local, no-key use accessible; those historical scores must not be
presented as Nimble/Ollama results.

The runner now supports both backends, but their default policies differ.
Comparing normal runs measures the model-plus-policy combination. To
isolate the model, match prompts, positions, legal actions, tournament
grouping, and scoring policy across backends.

**Recommended local run (no API key):**

Requires **Ollama 0.35.0 or newer** for the native `/v1/systemone`
endpoint.

```sh
node benchmark.js --pairs 10 --ollama-model nimble-go:latest
```

## Opponent anchors

The initial pool is deliberately small and reproducible:

| CLI name | Anchor | Role |
| --- | --- | --- |
| `greedy` | Current in-game one-ply heuristic | Reference anchor, assigned 1000 by convention |
| `choice-only` | Compact Choice-only policy from commit `6322135` | Historical Jev baseline; uses the same live API model and is version-stamped per game |
| `noise25` | Current heuristic replaced by a random legal move on 25% of turns | Matchup sensitivity check |
| `noise50` | Current heuristic replaced by a random legal move on 50% of turns | Matchup sensitivity check |
| `random` | Uniform random legal move | Lower-bound sanity check |
| `katago-5k` | KataGo human-SL `rank_5k` profile, one visit and temperature 1 | External labeled anchor; profile is not a calibrated Elo |

Jev is always represented as `White` in the prompt. When it plays actual
Black, the runner swaps the board colors, captures, and candidate result
boards before asking Jev to move, then translates its coordinate back to the
real game. Prompt komi is +5.5 for actual White and -5.5 for actual Black
represented as White; this keeps the model's score margin consistent
with the real game. The game itself retains the normal Black-first turn
order, area scoring, simple ko, and 5.5 komi for actual White.

## Run

Select Ollama's native decision endpoint with `--ollama-model MODEL`
(or `OLLAMA_MODEL`); `--ollama-host URL` defaults to `OLLAMA_HOST` or
`http://localhost:11434`. For TypeSafe instead, omit the Ollama model;
the runner reads `TYPESAFE_API_KEY` or `TYPESAFEAI_API_KEY` from the
environment or local `.env` without printing it. Ollama takes precedence
when both are configured. The runner requires Node.js 18 or newer.

```sh
node benchmark.js --pairs 10 --ollama-model nimble-go:latest
node benchmark.js --pairs 10                         # TypeSafe key required
node benchmark.js --pairs 10 --opponents greedy,choice-only
node benchmark.js --pairs 20 --opponents greedy,noise25,noise50,random
node benchmark.js --pairs 10 --opponents katago-5k
```

By default, `--pairs 10` means 20 games against `local-greedy`: ten Jev-Black
games and ten Jev-White games, paired by seed. Add opponents explicitly because
each Jev turn can require many API calls. Results print as the run proceeds
and are written to a unique `benchmark-results-*.jsonl` file (ignored by Git). Use
`--output PATH` to choose a different file. Each record includes the seed,
color, result, score margin, captures, passes, API calls, token usage, and
resolved model name. Games that reach `--max-turns` without ending are marked
`incomplete` and excluded from W-D-L, Elo, mean-margin, and sign-test
statistics; the summary reports their count separately.

Ollama benchmarking requires native `/v1/systemone`; unlike `server.js`,
the runner does not use the legacy chat adapter. Per-game records include
`decisionBackend` (`typesafe` or `ollama:<model>`) and `decisionPolicy`
(`choice-noul-tournament` or `score-choice-noul`). Ollama uses the same
Choice/Noul policy and shared tournament adapter as the browser. All
actions enter balanced groups of 2–26 candidates; their winners compete
in a final Choice. Finalist probabilities are not a full-set distribution.
TypeSafe retains a Score for each legal action.

Older Ollama records used the exhaustive scored policy and averaged
independent Choice distributions. Earlier color-swapped runs also had
incorrect prompt komi. Keep those historical results separate; they
are not measurements of the corrected current policy.

### Quick matched model comparison

On 2026-10-01, a three-position probe used local `nimble-go:latest`
(Nimble with a 16K context) and TypeSafe's `jev-latest`, resolved by the
API to `jev-1.13.0`. This is a **new cross-model probe**, separate from the
historical TypeSafe development benchmarks.

Both received the same state and mechanical facts generated by
`jev-go.html` at commit `590bbfc`, all legal actions plus pass, and the
same Choice/Noul instructions. The shared `runNativeDecision` adapter
ran balanced first-round groups and a comparison of group winners on
**both** backends, including TypeSafe. Each decision used two HTTP
requests. Neither model received per-candidate Scores. Provider order
alternated across positions; there was one trial per model per position.

| Position | Legal actions including pass | Nimble move / seconds | TypeSafe Jev move / seconds |
|---|---|---|---|
| Opening | 81 | G5 / 1.720 | B5 / 0.620 |
| Capture available | 75 | D5 / 1.551 | D5 / 0.629 |
| Seeded position | 61 | B2 / 1.960 | D2 / 0.562 |

All six decisions completed. Both models captured the Black stone at D4
by playing D5 in the capture fixture. No external engine evaluated the
other choices, and no games or ratings were produced. Mean observed
decision latency was 1.744s for Nimble and 0.604s for TypeSafe; different
tokenizers/reporting, hardware, networking, and caching preclude treating
this as a controlled inference-speed benchmark. It does not establish
which model plays stronger Go.

To reconstruct the fixtures, start from an empty board, play Black
first, and alternate colors through these coordinates; White then moves:

- Opening: `E5`.
- Capture: `D4 C4 J9 D3 J8 E4 A9`.
- Seeded position: `G7 D1 E6 B8 F4 F5 E7 D6 G3 E9 E1 G5 B4 D3 F1 A7 B7 E8 A3 B1 F3`.

The seeded fixture was generated without model answers: at each ply,
enumerate legal moves in the game's order, update a 32-bit LCG from seed
`20261001` with `s = (1664525 * s + 1013904223) mod 2^32`, and select
`s mod legalMoveCount`. All three fixtures were fixed before querying.
The normal benchmark CLI still uses backend-specific defaults; reproducing
this probe requires explicitly applying the shared tournament to both
providers, not simply comparing their default CLI runs.

### Trace output

Every run also writes `<output>.traces.jsonl` (same default naming), one JSON
line per ply of every game:

- `type: "position"` entries carry the game id (`opponent:seed:jevColor`),
  ply number, side to move, the pre-move board (row-major flat array of 81
  ints, `board[y * 9 + x]`), the ko snapshot (`null` after a pass), captures,
  consecutive passes, legal-move count, and the chosen move (`pass`, a
  coordinate, or `resign`). Jev's own plies additionally carry `jev`: the
  picked move, the raw Choice answer, confidence, choice probabilities, the
  Noul pass-gate probability, whether the pass gate allowed passing, and the
  selection method, probability scope, and per-candidate Scores
  (`null` for Ollama).
- `type: "terminal"` entries (one per game) carry the final board, the
  per-point area ownership map (`0` neutral, `1` Black, `2` White; stones
  count as their color, an empty region as the sole color it touches), the
  final scores, Jev's margin, the result, and how the game ended. For a turn
  cap, these are cutoff-position diagnostics and the result is `incomplete`.
  Ownership counts plus komi reproduce `blackScore`/`whiteScore` exactly.

The traces are the raw material for later value-function or prompt
calibration (DSPy/ReAnchor): every position is self-contained enough to
re-enumerate legal moves, and each carries the decision that was actually
taken together with the game's terminal outcome.

### KataGo setup

Install KataGo and place its official human-SL model at
`~/.local/share/katago/models/b18c384nbt-humanv0.bin.gz`:

```sh
brew install katago
mkdir -p ~/.local/share/katago/models
curl -fL 'https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz' \
  -o ~/.local/share/katago/models/b18c384nbt-humanv0.bin.gz
```

The runner discovers the Homebrew `b18c384nbt` main model and
`gtp_human5k_example.cfg`. Override paths with `--katago-bin`,
`--katago-model`, `--katago-human-model`, `--katago-config`, or the matching
`KATAGO_*` environment variables. For each game it selects `rank_5k`, one visit,
temperature 1, 9x9, 5.5 komi, and Chinese rules (simple ko, area scoring,
suicide illegal). Per-game JSONL records include both model SHA-256 hashes and
the resolved KataGo version. KataGo and the downloaded weights are local
dependencies and are not stored in this repository.

On Windows there is no Homebrew to discover, so download the CPU (Eigen)
build and the human-SL model, unzip the build under
`~/.local/share/katago/bin` (it ships `katago.exe`, the required DLLs, and
`gtp_human5k_example.cfg`), and pass every path explicitly:

```sh
node benchmark.js --pairs 10 --opponents katago-5k \
  --katago-bin ~/.local/share/katago/bin/katago.exe \
  --katago-model ~/.local/share/katago/models/b18c384nbt-humanv0.bin.gz \
  --katago-human-model ~/.local/share/katago/models/b18c384nbt-humanv0.bin.gz \
  --katago-config ~/.local/share/katago/bin/gtp_human5k_example.cfg
```

The default `--katago-human-model` path
(`~/.local/share/katago/models/b18c384nbt-humanv0.bin.gz`) matches this
layout. The Windows runs recorded below passed the human-SL model as both
the normal and the human model; with `humanSLProfile` active the human
model picks the moves, so the anchor's policy is the intended `rank_5k` one.

The single-pair setup pilot completed: Jev lost once as Black (−28.5 points)
and once as White (−53.5), using 105 API calls total. That confirms the engine
integration and color swap work; two games do not establish a useful strength
estimate.

A 10-pair Windows run (seeds 1-10, 20 games, `jev-1.13.0`, Eigen CPU build,
post-ko-fix engine) scored Jev 1-0-19 against the `rank_5k` profile: mean
margin −32.5, seed-paired 0-10, every game ending in two passes, 915 API
calls. Jev's only win was as White (+5.5); as Black it lost 0-10. Both sides
played the same simple-ko rules. The profile is decisively stronger than
Jev at this stage — the expected result against a labeled human-strength
anchor, and the useful external calibration point for future prompt work.

## Interpreting the rating

For each opponent, the runner reports the score rate and its Elo difference
using `400 * log10(p / (1 - p))`, where `p` counts a win as 1, a draw as 0.5,
and a loss as 0. The 95% range is a Wilson interval transformed through the
same formula. With only a few games this interval will be wide. A perfect
record displays an infinite point estimate and a finite confidence range where
possible; it does not mean the strength is known to be infinite.

Two exact two-sided sign tests accompany each opponent row:

- `sign test p` — the probability that wins and losses at least as lopsided
  as the observed record would arise from a fair coin (draws excluded). This
  asks whether Jev beats this anchor at all.
- `seed-paired p` — the same test on seed-paired games: each pair is one
  Jev-Black and one Jev-White game against the same seed, and a pair counts
  by the sign of its combined margin, which cancels the color advantage.
  This is the stricter color-balanced question and the one to read when
  comparing prompt variants.

Only pairs in which both color-swapped games finish are included in the
seed-paired test.

A p-value above roughly 0.05 means the record is indistinguishable from a
coin flip at this sample size — treat the Elo difference as unresolved
rather than as evidence of equality.

The number `1000` for `local-greedy` is an arbitrary local anchor. The direct
Elo differences against other opponents are separate head-to-head estimates;
they should not be averaged into one rating unless those opponents are also
calibrated against the same pool. These results are specific to this 9x9
ruleset and opponent set, not human or 19x19 Go ratings. The random/noisy
anchors are diagnostics, not independently rated Go engines. The KataGo
human-SL anchor is a model-labeled opponent, not a ground-truth Elo: KataGo
recommends one visit with full-temperature sampling to most closely imitate a
rank profile, and warns that the human model can have biases and pathologies.
See the [official human-SL guide](https://github.com/lightvector/KataGo/blob/master/docs/Analysis_Engine.md#human-sl-analysis-guide)
and [GTP rules reference](https://github.com/lightvector/KataGo/blob/master/docs/GTP_Extensions.md#kata-set-rules).
