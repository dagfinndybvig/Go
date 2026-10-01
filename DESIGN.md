# Design

Detailed design notes for *Jev Go*, a 9x9 Go game whose White stones are
played by a local [Ollama](https://ollama.com) decision model or
[Jev](https://www.typesafe.ai), TypeSafe AI's cloud "System One" model.
Ollama provides an accessible local option without an API key and keeps
positions on the configured host. TypeSafe Jev remains the original,
fully supported cloud backend.

**Development and benchmark provenance:** this project was originally
developed with TypeSafe Jev. The prompt evolution, mechanical-fact
experiments, and historical benchmark tables in this document describe
that TypeSafe work, not Nimble. Ollama support and its lighter tournament
policy were added afterward. Historical scores are not transferable
between models or policies.

## Overview

The player is Black; the machine is White. White is driven by the
TypeSafe Jev API or a compatible local Ollama decision model, with a
local greedy heuristic as fallback when neither backend is available.
The heuristic also drives Black in autoplay mode, so you can watch the
decision model against a greedy captures-and-liberties baseline. The
local heuristic is deliberately kept simple — no sequence reading, no
territory estimation — as a baseline for comparison.

This design is inspired by, and follows the architecture of,
[*Fight*](https://github.com/dagfinndybvig/Fight) — a one-on-one karate
game in the same Arcade collection whose AI opponent is also driven by
Jev. The Jev integration pattern (local CORS proxy, state text, `Choice`
question, argmax move selection) and the autoplay and log-panel concepts
originate there; this repo adapts them to Go's turn-based flow. Unlike
Fight, the decision model plays its best move here (argmax over the
distribution) rather than a temperature-sampled one. There is no
fallback on low confidence or errors — requests retry instead. The only
fallback is when no decision backend exists: the local heuristic plays
White.

### Why general decision models are weak at Go

Jev-compatible Ollama models and TypeSafe Jev are general-purpose
decision models, not dedicated Go engines. They receive a text
description of the board and return one move per turn
— no search tree, no Monte Carlo playouts, no learned board evaluation.
Dedicated Go AI (AlphaGo and its successors) needed deep neural
networks trained on millions of self-play games plus tree search to
reach human level; Jev has none of that machinery.

In earlier Go runs with tactical annotations, Jev's play showed three patterns:

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

The earlier prompt included a mid-game territory estimate, group-in-danger
scan, and 1-ply heuristic lookahead in each move description. The
compact-input experiment removed those derived annotations and measured
whether Jev does better with the board, concise metadata, and bare legal
move coordinates — it did, and that shape is the basis of every variant
since. The experiments that follow then added mechanical facts back, but
computed by the rules engine from the current position rather than
hand-derived annotations, and measured each step with paired
color-balanced games. The working rule that emerged: give Jev what it
cannot compute itself (mechanical consequences, group status), withhold
what it should judge itself (style, weighting, position verdicts).

#### Original 30-candidate benchmark

The original headless autoplay run capped Jev's candidate list at 30
moves (3 games, Jev White vs heuristic Black):

| Game | Moves | Score | Heuristic caps | Jev caps | Jev passes |
|------|-------|-------|----------------|----------|------------|
| 1 | 171 | 81-5.5 (Black) | 79 | 3 | 0 |
| 2 | 161 | 81-5.5 (Black) | 77 | 1 | 0 |
| 3 | 179 | 81-5.5 (Black) | 84 | 4 | 0 |

The heuristic won all three. Jev captured 8 stones total across 3 games;
the heuristic captured 240. Jev's average confidence was 0.33, with most
moves at 0.05-0.15. High-confidence picks (0.9+) were almost always
captures or atari saves. The 1-ply lookahead correctly warned Jev about
threats ("opponent can reduce your group to 2 liberties in reply"), but
Jev did not change its play pattern in response — it continued placing
stones adjacent to the opponent rather than claiming open space.

In this run the heuristic won all three games. These results describe
this matchup and the 30-candidate implementation; they do not establish
Jev's general game-playing strength.

#### Full legal move experiment

On branch `codex/jev-full-legal-move-list`, we compared the 30-candidate
baseline with the full legal move list using the same three heuristic
seeds and separate random streams for the heuristic and candidate
filter. The live API resolved `jev-latest` to `jev-1.13.0`.

| Seed | 30-candidate baseline | Full legal move list |
|------|-----------------------|----------------------|
| 1 | Black wins 81-5.5; 187 turns; 89/6 captures (Black/Jev) | Black wins 81-5.5; 163 turns; 78/1 captures |
| 2 | Black wins 81-5.5; 185 turns; 88/5 captures | Black wins 81-5.5; 187 turns; 88/8 captures |
| 3 | Black wins 81-5.5; 159 turns; 70/0 captures | Did not reach two passes within 600 turns |

The full-list variant sent up to 80 legal points, plus `pass`, in the
completed games. These three trials are mixed: the two completed full-list
games still lost, while the third did not finish within the runner's
600-turn limit. Treat the result as exploratory; the API uses the mutable
`jev-latest` alias and a three-seed sample is small.

#### Compact input experiment

On branch `codex/jev-compact-state`, the complete legal move list remains
available, but Choice options use coordinate names with null descriptions.
The state contains a compact board, captures, recent moves, komi, and pass
count, followed by a coordinate legend. It omits the territory estimate,
group-threat scan, and per-move lookahead annotations. The benchmark uses
the same three seeds and API model as the full-list run.

| Seed | Full-list annotated input | Compact state and null criteria |
|------|---------------------------|---------------------------------|
| 1 | Black wins 81-5.5; 163 turns; 78/1 captures (Black/Jev) | Black wins 81-5.5; 159 turns; 0/0 captures; Jev chose pass on 76/76 API calls |
| 2 | Black wins 81-5.5; 187 turns; 88/8 captures | Black wins 81-5.5; 159 turns; 0/0 captures; Jev chose pass on 77/77 API calls |
| 3 | Did not finish within 600 turns | Black wins 81-5.5; 159 turns; 2/0 captures; Jev chose pass on 75/77 API calls |

The compact prompt completed all three games. Jev chose `pass` on 228 of
230 API calls (99%), made no captures, and Black won all three; Black
captured two Jev stones in seed 3. The game also auto-passes if Jev has no
legal point left, which is separate from those API choices. Across the
230 calls, Jev used 175,509 input tokens (about 763 per call) and 81,074
output tokens; the API resolved `jev-latest` to `jev-1.13.0`. For the two
completed paired seeds, input tokens per call fell by about 54–56% versus
the annotated prompt, but the playing result was substantially worse.
The null-described choices were accepted by the API, so the pass behavior
is a model/prompt outcome rather than a request validation failure.

#### Multi-output candidate scoring experiment

On branch `codex/jev-candidate-scores`, each request asks Jev for a
`Choice` distribution over all legal moves, a `Noul` judgment on whether
passing is strategically sound, and one `Score` for every legal move plus
pass. The state adds each point move's exact delta from the current board:
the placed coordinate, captured Black stones, and the resulting White
group's liberty count. The shared Score rubric is 0–4 (major blunder to
excellent). This produces at most 84 outputs on an empty 9x9 board.

The game chooses the legal action with the highest
`Score + 0.05 * ln(max(Choice probability, 1e-9))`. Pass is considered
only when Jev's Noul probability for “passing is strategically sound” is
at least 0.5. The Score evaluates each move, Choice contributes a small
policy prior, and Noul gates pass.

| Seed | Result | Turns | Captures (Black/Jev) | Jev passes | API calls |
|------|--------|-------|---------------------|------------|-----------|
| 1 | Jev wins 46.5–39 | 82 | 0/1 | 1 | 41 |
| 2 | Jev wins 43.5–43 | 83 | 1/0 | 4 | 41 |
| 3 | Black wins 48–36.5 | 93 | 1/0 | 14 | 46 |

Jev won two of the three games. Across these games it passed 19 times in
128 API calls, versus 228 passes in 230 calls in the compact-input run.
The benchmark used 499,701 input tokens and 121,594 output tokens; the
API resolved `jev-latest` to `jev-1.13.0`. A separate empty-board request
validated all 84 output fields and used 7,337 input and 1,919 output
tokens.

These results are promising but exploratory. The old benchmark runner was
temporary and is not in the repository, so the new runner reused seed
labels 1–3 but its exact pseudorandom sequence could not be verified as
identical to the previous run. The sample is also only three games against
the deliberately simple local heuristic. One initial runner attempt
stopped after the 41st API response because the temporary harness tried
to apply `pass` as a coordinate; those partial calls are excluded from the
table and benchmark token totals. The progress report through call 40
showed 163,204 input tokens.

#### Ten-game paired comparison

The old benchmark harness was not retained, so this comparison uses one
reconstructed headless harness for both versions. It loads the compact
Choice-only source from parent commit `6322135` and the multi-output source
from this branch. Both use the same game rules, Black heuristic, terminal
scoring, 600-turn cap, and deterministic Mulberry32 random streams for
seeds 1–10. Every request in both cohorts resolved to `jev-1.13.0`.

| Seed | Compact Choice-only | Multi-output candidate scoring |
|------|---------------------|--------------------------------|
| 1 | Black 81–5.5; 159 turns; captures 1/0; Jev passed 75 times | Jev 43.5–41; 83 turns; captures 3/0; Jev passed 2 times |
| 2 | Black 81–5.5; 159 turns; captures 3/0; Jev passed 73 times | Black 66–20.5; 137 turns; captures 41/3; Jev passed 14 times |
| 3 | Black 81–5.5; 159 turns; captures 0/0; Jev passed 76 times | Jev 43.5–43; 83 turns; captures 0/0; Jev passed 6 times |
| 4 | Black 81–5.5; 159 turns; captures 0/0; Jev passed 76 times | Jev 42.5–42; 81 turns; captures 2/0; Jev passed once |
| 5 | Black 81–5.5; 159 turns; captures 1/0; Jev passed 75 times | Jev 44.5–41; 81 turns; captures 0/0; Jev passed twice |
| 6 | Black 81–5.5; 159 turns; captures 0/0; Jev passed 76 times | Jev 48.5–36; 82 turns; captures 0/2; Jev passed once |
| 7 | Black 81–5.5; 159 turns; captures 0/0; Jev passed 76 times | Jev 46.5–40; 78 turns; captures 0/0; Jev passed once |
| 8 | Black 81–5.5; 159 turns; captures 1/0; Jev passed 75 times | Jev 45.5–37; 80 turns; captures 0/1; Jev passed once |
| 9 | Black 81–5.5; 159 turns; captures 0/0; Jev passed 76 times | Jev 45.5–39; 76 turns; captures 0/0; Jev passed once |
| 10 | Black 81–5.5; 159 turns; captures 0/0; Jev passed 75 times | Jev 53.5–31; 88 turns; captures 0/11; Jev passed once |

Captures are shown as Black/Jev. Compact Choice-only lost all ten games.
Candidate scoring won nine; its seed-2 loss is a clear tactical failure,
with Black capturing 41 stones. Average game length fell from 159 to
86.9 turns. Jev's pass frequency fell from 753/759 API calls to 30/432.
The mean final score margin from White's perspective moved from −75.5 to
+1.8 points (median +5.0), but this is still a ten-game sample against a
weak local opponent, not a measure of general Go strength.

The extra evaluation is expensive: compact Choice-only used 582,407 input
tokens and 270,863 output tokens; candidate scoring used 1,703,197 input
tokens and 414,574 output tokens. The new version made fewer API calls
because its games ended sooner, but used about 2.9 times as many input
tokens overall and 5.1 times as many per call on average. The benchmark
runner was temporary and was deleted after recording these results, in
keeping with the repository's testing notes; the random generator and
settings above are recorded so a future retained runner can reproduce the
comparison.

The local heuristic is also deliberately weak — one-ply greedy, no
sequence reading, no life-and-death — so the two AIs are comparable in
strength. Autoplay is a baseline AI benchmark: two limited approaches
playing the same game, each showing what it can and cannot do.

#### Static advice block experiment

A fixed block of general Go principles was prepended to the evaluation
state — about 250 tokens per call, position-independent, identical every
turn. The retained runner ran 5 color-balanced pairs (10 games, seeds
1–5) against the greedy anchor with and without the block, same seeds,
both resolving to `jev-1.13.0`.

| Variant | Jev W-D-L | Score rate | Mean margin | API calls | Input tokens |
|---------|-----------|------------|-------------|-----------|--------------|
| Baseline (no advice) | 3-0-7 | 30.0% | −4.0 | 418 | 1,680,207 |
| With advice block | 4-0-6 | 40.0% | −45.2 | 615 | 2,160,695 |

The win rate moved from 30% to 40%, well inside the overlapping 95%
ranges, but the mean margin collapsed from −4.0 to −45.2. Without the
block, Jev's losses were close (−0.5 to −20.5). With the block, five
losses were catastrophic: Jev captured 0–1 stones while the greedy
anchor captured 67–75, with games stretching to 159–161 plies and Jev
passing 5–13 times. The passive-sounding principles ("do not attach",
"do not play inside solid opponent territory", "first- and second-line
points are usually too small") are the likely cause: they steered Jev
away from contact, letting the greedy opponent build territory and
capture whole groups. The block was reverted after the run; the exact
text is preserved here for future per-principle tests:

```
General Go principles for choosing a move:
- Save your own groups in atari; capture opponent groups in atari.
- Keep stones connected: separated stones can be attacked one at a time.
- Stones with two or three liberties are weak. Give your weak groups liberties; reduce the liberties of weak opponent groups.
- A group with two eyes cannot be captured. Make eye shape for groups you cannot afford to lose.
- Beware ladders: a capture that starts a ladder fails if the opponent can play a ladder blocker ahead of it.
- Balance territory and influence. Third- and fourth-line points are good early; first- and second-line points are usually too small.
- Do not attach to strong opponent stones without a reason; contact fights often help the stronger side.
- Do not fill your own eyes, and do not play inside solid opponent territory unless the new group can live.
- Prefer moves that both build your area and reduce the opponent's.
```

#### Aggression style experiment

Instead of adding knowledge, the Choice and Score instructions were
reweighted toward high aggression: "hunt captures, attack and cut weak
opponent groups, invade and reduce opponent territory... defend only
when a group is in immediate danger", with the Score rubric told to
favor captures, ataris, cuts, and invasions over quiet moves. Same
runner, 5 pairs, seeds 1–5, greedy anchor, both resolving to
`jev-1.13.0`.

| Variant | Jev W-D-L | Score rate | Mean margin | API calls | Input tokens |
|---------|-----------|------------|-------------|-----------|--------------|
| Baseline (balanced instructions) | 3-0-7 | 30.0% | −4.0 | 418 | 1,680,207 |
| Aggression directive | 0-0-10 | 0.0% | −81.0 | 739 | 2,882,902 |

Every game collapsed identically: as Black, Jev ended with zero stones
on the board (0 to the greedy anchor's 86.5); as White, only komi (5.5
to 81). The anchor captured 64–71 stones per game while Jev captured
none, and Jev passed 8–15 times. The margins were identical across all
seeds, so the collapse was deterministic: the directive pushed Jev into
contact fights it cannot evaluate without search, it repeatedly played
into atari against an opponent that captures any zero-liberty group,
lost every stone, and passed out the remaining plies. A style directive
that raises aggression without adding reading ability was strictly
harmful; reverted after the run.

#### Position facts experiment

Two mechanical facts were added to the evaluation state, computed by the
rules engine each turn: groups with 3 or fewer liberties (both colors,
with stone counts, liberty counts, and atari flags) and capture threats
(which White stones Black can capture on their reply). Mechanical
language only — no evaluative framing. Same runner, 5 pairs, seeds 1–5,
greedy anchor, both resolving to `jev-1.13.0`.

| Variant | Jev W-D-L | Score rate | Mean margin | API calls | Input tokens |
|---------|-----------|------------|-------------|-----------|--------------|
| Baseline (no facts) | 3-0-7 | 30.0% | −4.0 | 418 | 1,680,207 |
| With position facts | 6-0-4 | 60.0% | +4.7 | 416 | 1,681,185 |

The facts doubled the win rate and flipped the mean margin positive at
identical cost (416 vs 418 calls, same tokens). Jev won 2/5 games as
Black (0/5 in the baseline), and no game was catastrophic — all margins
stayed within −8.5 to +18.5, versus the baseline's uniformly losing
Black games. This is the first intervention that clearly helped, and it
completes the pattern from the two prior experiments: exact rules-engine
facts improve play, evaluative framing hurts. The facts block is kept in
the game.

#### Score-estimate fact experiment

A third fact was added to the facts block: the current area-score
estimate (stones + empty regions touching only one color, komi 5.5) as
it would stand if the game ended now. Same runner, 5 pairs, seeds 1–5,
greedy anchor, `jev-1.13.0`.

| Variant | Jev W-D-L | Score rate | Mean margin | API calls | Input tokens |
|---------|-----------|------------|-------------|-----------|--------------|
| Group facts only | 6-0-4 | 60.0% | +4.7 | 416 | 1,681,185 |
| Group facts + score estimate | 3-0-7 | 30.0% | −31.0 | 552 | 1,951,819 |

The score estimate undid the group-facts gain: back to 3-0-7 with a
−31.0 mean margin, and the catastrophic pattern returned. In the three
blowout losses Jev passed 22–23 times and lost every stone (0 captures,
44–58 captured by the anchor) in 145–160-ply games. The "if the game
ended now" framing apparently read as "the position is settled": when
the estimate looked decided, Jev passed, letting the greedy anchor
capture whole groups. A fact about the final score is not the same kind
of input as a fact about the board — it invites settling rather than
fighting. Reverted after the run; the group facts remain.

#### What helps and what hurts

Five experiments with the same runner and seeds draw one distinction:

| Input type | Examples | Measured effect |
|------------|----------|-----------------|
| Facts the board computes | Candidate deltas, weak-group scan, capture threats | Helps: 9/10 vs Choice-only; 30% → 60% vs baseline |
| Balanced tactical instructions | "Save groups in atari, capture, build territory, keep connected" | The working baseline |
| One-sided reweighting | Aggression directive (0-10, margin −81); passive principles (margin −45) | Hurts in both directions |
| Verdicts about the position | Score estimate "if the game ended now" | Hurts most: invites passing (margin −31) |

The baseline instructions already tell Jev what to do, and that works —
obedience is not the problem. The failures share a shape: Jev complies
with whatever the prompt emphasizes, without checking it against the
position. One-sided reweighting removes the balance it cannot restore
itself; a verdict pre-empts the evaluation and Jev acts on it rationally
(a settled score makes passing correct, so it passes and loses every
stone). The working rule: give Jev what it cannot compute itself —
mechanical consequences, group status — and withhold what it should
judge itself: how strongly to weight attack, whether the position is
settled.

#### Twenty-game confirmation of the position facts

The group-facts variant (weak-group scan + capture threats) was
confirmed over 10 color-balanced pairs (20 games, seeds 1–10) against
the greedy anchor, `jev-1.13.0`.

| Variant | Games | Jev W-D-L | Score rate | Mean margin | Black wins | API calls | Input tokens |
|---------|-------|-----------|------------|-------------|------------|-----------|--------------|
| Baseline (no facts) | 10 | 3-0-7 | 30.0% | −4.0 | 0/5 | 418 | 1,680,207 |
| Group facts, 10 games | 10 | 6-0-4 | 60.0% | +4.7 | 2/5 | 416 | 1,681,185 |
| Group facts, 20 games | 20 | 14-0-6 | 70.0% | +1.9 | 7/10 | 994 | 3,728,281 |

The 20-game run confirms the gain: 70% versus the baseline's 30%, with
Jev winning 7/10 as Black (0/5 in the baseline) and a positive mean
margin. Several wins were large (+45.5, +58.5, +75.5, with Jev capturing
38–59 stones). The failure mode is reduced but not eliminated: three of
the six losses were the catastrophic pattern (every stone captured,
159–160 plies, 10–21 passes), so the facts mitigate the blindness
without removing it.

#### Ladder warnings in the candidate deltas

The remaining catastrophic losses come from one-ply blindness: Jev sees
a group's liberty count but cannot read that an atari extension still
dies in a ladder. The rules engine can. `ladderCaptured()` simulates the
atari–extend sequence (opponent ataris at each liberty, the group
extends at its last liberty, repeated up to 30 steps, with suicide and
edge effects handled by `tryMove`), and each candidate point whose
resulting group would be captured that way carries a mechanical warning
in its delta line, alongside the existing immediate-capture warning for
groups left with one liberty.

Confirmed over 10 color-balanced pairs (20 games, seeds 1–10) against
the greedy anchor, `jev-1.13.0`:

| Variant | Games | Jev W-D-L | Score rate | Mean margin | Worst loss | Catastrophic losses |
|---------|-------|-----------|------------|-------------|------------|---------------------|
| Group facts, 20 games | 20 | 14-0-6 | 70.0% | +1.9 | −86.5 | 3 |
| + ladder warnings, 20 games | 20 | 13-0-7 | 65.0% | +6.9 | −35.5 | 2 |

The score rate is within noise of the group-facts variant (13 versus 14
wins), but the loss profile improved exactly where the warnings aimed:
the worst loss went from −86.5 (every stone captured) to −35.5, the
mean margin rose from +1.9 to +6.9, and catastrophic losses fell from
three to two. The warnings are mechanical consequences, not verdicts,
so they follow the working rule above. Kept.

#### Snapback and Black-group fate facts

Two more mechanical facts in the same family, both targeting the
remaining no-search blindness:

- Snapback trades: when a move captures stones but still leaves the
  played group with one liberty, the line now states both counts
  ("Black recaptures the group (N stones) next turn; White captured M
  this move") instead of only the capture warning, so Jev can judge
  the trade itself.
- Black-group fate: when a move ataris or ladder-catches a Black group,
  the line reports whether Black can save it — `blackGroupFate()`
  simulates Black's saving extension and, if the extended group still
  has at most two liberties, reuses `ladderCaptured()` for the chase.
  Three outcomes: "cannot extend (White captures it next turn)",
  "caught in a ladder even if Black extends", "can escape by
  extending". When the extension gains three or more liberties the
  deeper chase is not evaluated and nothing is claimed. The facts are
  suppressed when the played White group is itself in atari (Black
  would capture it first).

  A bounded liberty-race chase for 3-liberty extensions
  (`raceCaptured()`: White fills a liberty, Black answers at any
  liberty, claim only on proven capture within budget) was tested over
  40 paired games (seeds 1-20, `jev-1.13.0`, post-ko-fix engine,
  baseline `benchmark-results-race-baseline*.jsonl` vs
  `benchmark-results-race-facts.jsonl`). The seed-paired record was
  unchanged (14-5, p = 0.064 both) and the loss profile worsened (mean
  margin +10.5 to +2.3, worst loss -75.5 to -86.5, catastrophic losses
  2 to 3). Locally the claim fired in only ~0.15% of weak-group calls
  over 2,182 trace positions. No measured benefit; reverted, like the
  score-estimate fact. 4+ liberty capturing races remain unclaimed.

Confirmed over 10 color-balanced pairs (20 games, seeds 1–10) against
the greedy anchor, `jev-1.13.0`:

| Variant | Games | Jev W-D-L | Score rate | Mean margin | Worst loss | Catastrophic losses |
|---------|-------|-----------|------------|-------------|------------|---------------------|
| Group facts, 20 games | 20 | 14-0-6 | 70.0% | +1.9 | −86.5 | 3 |
| + ladder warnings, 20 games | 20 | 13-0-7 | 65.0% | +6.9 | −35.5 | 2 |
| + snapback/fate facts, 20 games | 20 | 12-0-8 | 60.0% | +11.8 | −18.5 | 1 |

The score rate drifted down one win per step (14 → 13 → 12, all within
noise), while every loss metric improved monotonically: worst loss
−86.5 → −35.5 → −18.5, catastrophic losses 3 → 2 → 1, mean margin
+1.9 → +6.9 → +11.8. The facts trade a little win rate for the
near-elimination of the catastrophic collapse. Kept.

#### Full-anchor benchmark with paired significance tests

The runner's summary now reports two exact two-sided sign tests: a
per-game test on the win/loss record (draws excluded) and a stricter
seed-paired test — each pair is one Jev-Black and one Jev-White game
against the same seed, counted by the sign of the pair's combined
margin, which cancels the color advantage. The current build (all
facts) then ran Lukas's full local-anchor standard: 20 color-balanced
pairs against each of `greedy`, `noise25`, `noise50`, and `random`
(160 games, seeds 1–20, `jev-1.13.0`). The KataGo anchor was not run —
KataGo is not installed on this machine.

| Anchor | Jev W-D-L | Score rate | Elo Δ [95% approx] | Mean margin | Sign p | Seed-paired p |
|--------|-----------|------------|---------------------|-------------|--------|---------------|
| local-greedy | 26-0-14 | 65.0% | +108 [−3 to 219] | +17.6 | 0.081 | 0.0044 |
| greedy + 25% random | 30-0-10 | 75.0% | +191 [69 to 313] | +37.4 | 0.0022 | 0.0004 |
| greedy + 50% random | 35-0-5 | 87.5% | +338 [181 to 495] | +54.5 | <0.0001 | <0.0001 |
| uniform random | 40-0-0 | 100.0% | +∞ [407 to ∞] | +81.0 | <0.0001 | <0.0001 |

The seed-paired test is the one that matters, and it resolves what the
per-game test could not: against `greedy`, the raw record (26-14,
p = 0.081) looks like a coin flip at 40 games, but the color-balanced
pairs are 16-3 (p = 0.0044) — Jev's advantage is real once the color
split is cancelled. The strength gradient against the noise anchors is
monotonic and highly significant, as it should be. This establishes the
current build's rating against the local pool; future prompt variants
should be judged by seed-paired p-values at this sample size, not by
raw win rates at 20 games.

**Timing caveat**: this run predates the simple-ko fix (`174139f`).
The engine that produced these 160 games did not block immediate ko
recaptures — `isKo` compared the candidate against the current board,
which no legal move can equal, so the check never fired — meaning the
games were played without the simple ko rule the docs described. A
post-fix confirmation (10 pairs vs `greedy`, seeds 1-10, `jev-1.13.0`,
`benchmark-results-ko-fix-greedy.jsonl`) scored 16-0-4 with seed-paired
p = 0.0039, against 14-0-6 (p = 0.021) for the same seeds pre-fix, so
the headline holds under the corrected rules. The table is kept as
originally measured; the other anchors have not been re-run post-fix.

### KataGo's role in the evaluation

KataGo entered in Lukas's rebuild (`aef43a7`) as the design's one
external anchor: the local pool is self-referential — every local
opponent is defined by this repo's own heuristic, so win rates against
it cannot say whether Jev got absolutely stronger.

During the mechanical-facts generation it was not the judge. Every
fact variant (position facts, ladder warnings, snapback, the reverted
advice block and score-estimate) was kept or dropped on seed-paired
results against local anchors alone; the full-anchor standard ran the
four local anchors and not KataGo, which was not installed on the
measurement machine. KataGo's only appearance was the two-game pilot
(−28.5, −53.5), which validated the engine integration and the color
swap, not strength.

The external evaluation came after generation 3 was finished and the
simple-ko fix landed: 20 color-swapped games on Windows against the
`rank_5k` profile scored 1-0-19, mean margin −32.5, worst −64.5 (see
BENCHMARK.md). Two readings. The facts generation's improvements are
relative, not absolute — the build that beats greedy 30-10 and cut
catastrophic losses still loses 19 of 20 to a profile labeled 5 kyu,
and its collapse profile against KataGo mirrors the one the facts line
reduced against greedy. And the rules-parity claim behind this anchor
was false until `174139f`: KataGo is the only opponent whose own
engine would have rejected a ko recapture, which is why the ko audit
mattered for this anchor at all.

Going forward, judge calibration work (DSPy/ReAnchor, built on the
position traces) on both pools: the local pool detects changes cheaply
and seed-pairs them, but only the external anchor detects overfitting
to greedy. The `rank_5k` profile is a model label, not a calibrated
Elo (see BENCHMARK.md for the caveats).

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
`lastMove` stores the board *as it stood before the move just applied*
(`applyMove` captures the pre-move position), not the move's result
board — the result equals the current position during the next turn,
which would make the comparison a permanent no-op. `doPass` clears
`lastMove` to `null`, lifting the ko restriction after a pass.
`benchmark.js` keeps the same semantics in its own `playGame` loop.

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

### Jev-compatible decision AI

White's moves are chosen by TypeSafe Jev or an Ollama model. Interactive
Ollama play requires **Ollama 0.35.0 or newer** and requests a complete
Choice and Noul pass gate; TypeSafe also requests exhaustive candidate
Scores. The server retains a JSON-schema chat adapter for compatibility,
but older Ollama versions are not the supported setup. Without either
backend, White falls back to the local heuristic.

- **Browser endpoint**: `POST /jev` when served locally
- **Upstream**: TypeSafe `/v1/systemone`, Ollama `/v1/systemone`, or
  Ollama `/api/chat` through the compatibility adapter
- **Model**: `jev-latest` on TypeSafe; `OLLAMA_MODEL` (or the
  auto-detected first context-compatible installed model) on Ollama
- **Outputs**: Ollama interactive play uses one `Choice` and one `Noul`;
  TypeSafe adds a `Score` for each legal point plus pass (up to 84
  outputs on a 9x9 board)
- **Fetch timeout**: 10s for TypeSafe, 30s for Ollama, via
  `AbortController`
- **Retry**: on error or timeout, `jevMove` retries up to 3 times (1s
  between attempts). If all retries fail, an error message is shown and
  no move is played — the game waits. HTTP 4xx errors other than 408/429
  are not retried.

#### State sent to the decision model

`buildEvaluationState()` assembles a compact text description plus
candidate move deltas:

- Rules and side mapping: White is `X`, Black is `O`, area scoring,
  komi 5.5, and two consecutive passes end the game.
- The benchmark uses `promptKomi = -5.5` when actual Black is represented
  as White, and +5.5 for actual White. This changes the prompt, not real
  scoring, and is restored with the engine snapshot. Historical paired
  results above predate this correction and should be rerun.
- Captures, consecutive pass count, and the recent move for each side.
- A compact board with row 9 first and row 1 last; `.` is empty.
- A coordinate legend at the end of the state: columns left-to-right
  `A B C D E F G H J` (I omitted), rows bottom-to-top 1–9, and Choice
  names identify board intersections.

Each legal point adds its captured-stone coordinates and the
resulting liberties of the played White group, so Jev can evaluate the
counterfactual without receiving 81 full successor boards. When the
played group would be left in atari, or in atari-after-extension that a
ladder captures, the point's line carries a mechanical warning ("Black
captures the group (N stones) next turn" / "Black captures the group in
a ladder (N stones)"); when the
move captures stones and the played group is still left with one
liberty, the line states both counts so Jev can judge the snapback
trade itself. Moves that atari or ladder-catch a Black group carry the
group's fate ("cannot extend", "caught in a ladder even if Black
extends", "can escape by extending") — computed with Black's saving
extension simulated, and withheld when the extension gains three or
more liberties. A mechanical facts block follows the board: groups with
3 or fewer liberties (both colors, with stone and liberty counts and
atari flags) and capture threats (which White stones Black can capture
on their reply).

#### Candidate move set

The decision model receives every legal point. A 9x9 board has at most
81 legal moves; the Choice also includes `pass`, for at most 82 actions.
TypeSafe gives each action its own Score output, plus the Choice and
Noul outputs, for at most 84 named outputs. Ollama omits the repeated
Scores for responsive interactive play but keeps the complete Choice.
This keeps distant opening and territory moves available instead of
shortlisting moves by proximity to existing stones.

#### Choice criteria

Choice criteria are keyed by their coordinate (`E5`) and have null
descriptions; `pass` is also null-described. The Noul output asks
whether passing is strategically sound. On TypeSafe, each action's
separate Score field uses the same five-level rubric: major blunder,
poor, playable, good, excellent.

The output names are `move` for Choice, `pass_ok` for Noul, and
`quality_<coordinate>` for each Score (for example, `quality_E5` and
`quality_pass`). When a full scoring request is used, native Ollama and
TypeSafe return the expected ordinal score for each Score field. This
experiment uses that raw value; it has not calibrated the rubric or
trained the model with DSPy/ReAnchor.

#### Move selection

TypeSafe combines each point's expected Score with a small log prior
from the Choice probability. Ollama uses balanced groups of 2–26 actions
and compares their winners in a final Choice. The shared adapter
`ollama-decision.js` never averages independently normalized group
probabilities. Every legal action participates in round one; returned
probabilities and confidence refer only to the finalists, tagged
`selection: "tournament"` and `probabilityScope: "finalists"`. This
tournament is an approximation, not a full-set softmax.

Ollama uses that final Choice argmax in both browser and benchmark.
Both backends consider `pass` only when the Noul probability is at least 0.5. There is
no temperature or sampling. If a required typed answer is missing, the
request fails and follows the existing retry path.
This is a one-ply decision: the model scores resulting move effects, but
the game does not search opponent replies or build an MCTS tree.

#### Error handling

There is no fallback on low confidence or backend errors — the game
retries instead. The only fallback is when no decision backend exists:

- No Ollama model or TypeSafe key: the HUD shows "WHITE: LOCAL AI" and
  White is played by the local heuristic. The game continues.
- Timeout (10s TypeSafe, 30s Ollama), HTTP 408/429/5xx, or network error:
  `jevMove` retries up to 3 times with
  1s between attempts. If all retries fail, an error message is shown
  and the game waits — it does not substitute the heuristic.
- Illegal choice: retried up to 3 times, then an error message is shown.
- Other HTTP 4xx errors: display the upstream detail immediately.
- Backend discovery errors: show an error rather than using the heuristic.
  White waits for discovery; configuration is not proof of a healthy model.

Every error is logged with its reason; every successful decision is
logged with both Jev's original pick and the played pick.

## When you can use a decision model

Decision AI depends on the local server. The TypeSafe API does not send
CORS headers, and browsers do not call Ollama directly:

| How you open the game | Decision AI? | Why |
| --- | --- | --- |
| `file://` (double-click `jev-go.html`) | No | There is no local `/jev` server. White uses the heuristic. |
| `http://localhost:3000` (`node server.js`) | Yes, with Ollama or a TypeSafe key | Explicit `OLLAMA_MODEL` wins; otherwise a TypeSafe key wins; without a key, the first context-compatible installed Ollama model is auto-detected. |
| Hosted (GitHub Pages) | No | There is no proxy, and direct TypeSafe calls are blocked by CORS. Run `node server.js` locally. |

The HUD in the bottom-right corner reflects this at all times:

- **`WHITE: OLLAMA <model> (version, mode)`** or **`WHITE: JEV`** —
  selected backend; amber until verified or while a request is running,
  green after a successful decision, red on failure
- **red `WHITE: LOCAL AI`** — no backend exists

`GET /jevstatus` reports configuration (`serverKey`, `backend`, `mode`,
and `version`), not health. The game awaits it before choosing White's
driver. Discovery has a 5-second deadline and is retried on a subsequent
attempt after failure.

## Autoplay modes

There are two play modes, toggled with **0**:

### Manual mode (default)

You click to place Black stones; White is the active decision model.
Pass and Undo work. Clicks during White's turn or after game over are
ignored. Without a backend, White is played by the local heuristic.

### Autoplay mode

The active decision model (White) plays against the local heuristic
(Black) with no human input:

- Each side moves on a ~700ms cadence (`AUTO_DELAY`).
- When the game ends, the result stays on screen for 4 seconds, then a
  new game starts automatically — the comparison runs continuously.
- The score line and game-over message name the AIs instead of "you":
  **Local AI** (Black) vs **Ollama** or **Jev** (White), or
  **Local AI 1** vs **Local AI 2** when no backend exists. Labels are
  computed by one `labels()` function.
- Pass and Undo are disabled; clicks are ignored.
- Toggling autoplay **off** mid-game returns control immediately: you
  play Black from the current position, and the normal manual flow
  resumes.
- Without a decision backend, both sides use the local heuristic (Local AI 1
  vs Local AI 2) — the game keeps playing.

**What autoplay actually compares depends on hosting** — this is the
subtle part:

| Hosting | Autoplay is |
| --- | --- |
| `localhost:3000` with Ollama or a TypeSafe key | decision model vs local heuristic |
| `localhost:3000` without a backend | local AI vs local AI |
| GitHub Pages or `file://` | local AI vs local AI |

The comparison is meaningful only when `/jevstatus` identifies an
Ollama or TypeSafe backend.

## HUD and logging

- **Backend indicator** (under the title): reports discovery, configuration
  not yet verified, a request in progress, the last decision succeeding,
  errors, or local fallback. Green means a decision succeeded, not that
  configuration alone proves connectivity.
- **Matchup line** (under the title, yellow, large): exactly who is
  playing who, with stone glyphs — `● You (Black) vs ○ Ollama (White)`,
  `● You (Black) vs ○ Jev (White)`, `● You (Black) vs ○ Local AI
  (White)` (no backend), or the corresponding autoplay matchup.
- **Game-over overlay** (across the board): when the game ends, the
  result — winner and score — appears in large red letters on a dark
  panel over the board. It is cleared by New game, Undo, or the
  autoplay restart.
- **Controls row**: Pass, Undo, New game, plus buttons for the mode
  options — `Autoplay: off/on (0)`, `TypeSafe key (J)`, `Jev log (L)`.
  Every keyboard shortcut has a visible button equivalent.
- **Player combinations panel** (under the score, bordered): the
  matchups — you vs Ollama/TypeSafe decision AI, you vs local AI, local
  AI vs decision AI, or local AI vs local AI — and the keys/buttons
  that switch them.
- **Status line** (top): whose turn it is, whether the decision backend
  is thinking, the completed move, detailed HTTP errors, illegal move
  reasons, retry status, and the game result. No timer or elapsed time
  is displayed.
- **Score line**: captures for both sides with stone glyphs, labeled
  "● You (Black)" or "● Local AI (Black)" depending on mode.
- **`WHITE: OLLAMA ...` / `WHITE: JEV` / `WHITE: LOCAL AI`**
  (bottom-right): which backend is driving White and its decision status.
- **`AUTOPLAY (0 to toggle)`** (bottom-left, yellow): autoplay is on.
- **Jev log panel** (`L`, bottom-left): the last 10 decisions in reverse
  order — timestamp, played point, confidence, and Jev's original pick
  when the argmax overrode it; errors are shown with their reason.
- **Console**: `window.jevLog()` returns the full 200-entry ring buffer;
  `window.jevClear()` empties it. Log entries carry `{ t, ok, choice,
  jevChoice, confidence, probabilities, passProbability, passAllowed,
  scores, usage, model, state, reason }`. Ollama also records `selection`
  and `probabilityScope`; its `scores` are null.

## Architecture

```
index.html    — redirect to jev-go.html (GitHub Pages serves index.html at the root)
jev-go.html   — entire game: rules, rendering, both AIs, UI (single file, no dependencies)
server.js     — local Node.js server + Ollama/TypeSafe decision proxy
benchmark.js  — paired Ollama/TypeSafe rating runner and trace writer
ollama-decision.js — shared validation, question batching, and Choice tournament
OLLAMA.md     — recommended local backend setup and protocol details
```

`server.js` serves the static game on port 3000 and answers `POST /jev`
from an explicit Ollama model, TypeSafe, or an auto-detected Ollama
model, in that order. Native requests are validated, assigned the configured
model, batched into at most 44 questions, and large Choices use the shared
tournament adapter. The compatibility adapter maps every Choice,
Noul, and Score question into a constrained chat response and rejects
partial replies. The TypeSafe key may come from either
`TYPESAFE_API_KEY` or `TYPESAFEAI_API_KEY` in the environment or local
`.env`; a browser key takes precedence on that path. Hidden files are
blocked from static requests. Root URLs with query strings serve the same
game as `/`. `GET /jevstatus` reports the selected
backend, decision mode, and Ollama version. The server
binds to `127.0.0.1` by default so the LAN cannot reach the proxy and
spend the server key; `HOST=0.0.0.0` opts into LAN exposure deliberately.
`/jev` request bodies over 256 KB are refused with `413` instead of
being buffered in memory. TypeSafe upstream calls have a 15-second
timeout and Ollama calls have a 30-second timeout; timed-out requests
return `504` and the upstream is destroyed.

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

**Mid-game failure**: if the server dies, transient move failures retry
up to 3 times (10s TypeSafe, 30s Ollama per attempt), then the game waits.
Restart the server and undo/replay the Black move or start a new game
after retries are exhausted. Each White turn waits for backend discovery.
New Game/Undo cancel the delayed White timer and abort in-flight requests.
A generation guard protects the board, log, and status from late responses;
a single-request guard prevents duplicate decisions for one turn.

### Constants

| Constant | Value | Purpose |
| --- | --- | --- |
| `N` | 9 | Board size |
| `MARGIN` | 30 px | Grid inset on the canvas |
| `CELL` | 51 px | Intersection spacing ((468 − 60) / 8) |
| `AUTO_DELAY` | 700 ms | Pause between autoplay moves |
| `LOG_MAX` | 200 | Jev decision ring-buffer size |
| fetch timeout | 10000 / 30000 ms | TypeSafe / Ollama, including response body and native rounds |
| retry limit | 3 | Retries on error/timeout before giving up |
| komi | 5.5 | Points added to White's area score |
