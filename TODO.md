# TODO

## Current experiment: Jev multi-output move scoring

- [x] Keep the complete legal point list plus `pass` in a Choice output.
- [x] Add a same-rubric Score output for each legal move and pass.
- [x] Add a Noul pass gate and use Choice probabilities as a small policy
      prior when ranking the per-move Scores.
- [x] Send exact candidate deltas and benchmark three seeded autoplay
      games; record results and limitations in DESIGN.md.
- [x] Compare compact Choice-only against multi-output scoring over the
      same ten deterministic seeds; record per-game outcomes and token
      usage in DESIGN.md.
- [x] Test a static general-advice block in the state: it measurably
      hurt (mean margin −4.0 → −45.2 over paired seeds; see DESIGN.md)
      and was reverted.
- [x] Test a high-aggression style directive in the instructions: 0-10,
      Jev lost every stone in every game (see DESIGN.md); reverted.
- [x] Add mechanical position facts to the state (weak-group scan +
      capture threats): 3-0-7 → 6-0-4 over paired seeds at identical
      cost; kept (see DESIGN.md).

## Next steps

- [ ] Save position-level traces and terminal area margins before trying
      DSPy/ReAnchor calibration.

## Done (pushed)

- [x] Keep a reproducible benchmark runner: `benchmark.js` is committed,
      with color-balanced pairs, anchor definitions (BENCHMARK.md), and
      Mulberry32 seeds.

- [x] Autoplay status line lists players Black-first (commit `d7d65c2`)
- [x] Canvas flipped to Go orientation: row 1 at bottom, matching Jev's text
      board (commit `4cbca62`)
- [x] `jevLastChoice` updated after heuristic fallback (commit `4cbca62`)
- [x] `heuristicPick` guard against empty/null moves (commit `c72ef84`)
- [x] Confidence floor lowered from 0.3 to 0.1 (commit `f588128`)
- [x] Removed all fallbacks: Jev always plays White, retries on error instead
      of substituting heuristic. No `fallbackToHeuristic`, no `whiteIsJev`,
      no `CONFIDENCE_FLOOR`. `labels()` simplified. Timeout 3s -> 10s.
      (commit `014223f`)
