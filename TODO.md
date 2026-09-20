# TODO

## In progress (uncommitted, working copy)

### Jev plays better against the heuristic

Jev was getting crushed by the local heuristic (40+ stones vs 0-4, 30+ captures
against). Root cause: Jev received 70+ move options where 90% were described as
just "open point" or "edge point" — zero tactical information. It played blind.

Changes made but not yet committed:

- [x] Richer move descriptions (`describeMove`): every move now reports
      resulting group liberty count, saves from atari, puts opponent in atari,
      reduces opponent to 2 liberties, extends own group, contact with enemy
- [x] Group threat scan in state text (`buildState`): lists all groups with
      1-2 liberties (both colors) with their coordinates, so Jev sees what's
      in danger before choosing
- [x] Move filtering (`filterMoves`): when >30 legal moves, prioritize captures,
      atari saves, moves near existing stones, and center bias. Jev gets 30
      focused options instead of 70+ generic ones
- [x] Updated question instructions to emphasize group safety and connection
- [x] Always report resulting liberties on every move (not just dangerous ones)

Still losing: Jev still plays into confined spaces and gets captured. More work
needed.

## Next steps

- [ ] Jev still gets surrounded. Consider:
      - Reporting the max opponent response capture for each move (what can
        Black capture in reply), so Jev avoids moves that invite capture
      - Adding "connects two groups" detection when a move joins two separate
        friendly groups into one
      - Larger state-text hint about keeping groups connected and avoiding
        moves with only 2 liberties in enemy contact
- [ ] Test with the live API to measure improvement
- [ ] Once Jev is competitive, commit and push all uncommitted changes

## Done (pushed)

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
