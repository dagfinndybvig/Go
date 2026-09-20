# Go rules — short recap

Go is played on a 19x19 board (9x9 here). Two players take turns placing
stones on the intersections: Black first, then White. Once placed, a
stone never moves — it can only be captured.

- **Liberties** — the empty points adjacent to a stone. A group of
  connected same-color stones shares its liberties.
- **Capture** — when a group's last liberty is filled by the opponent,
  the whole group is removed from the board.
- **Suicide** — you may not play a stone that leaves your own group with
  no liberties, unless that move captures first.
- **Ko** — you may not immediately recreate the board position that
  existed before your opponent's last move. This prevents endless
  back-and-forth capture of a single stone.
- **Passing** — you may skip your turn. Two consecutive passes end the
  game.
- **Scoring** — in area scoring (used here), each side scores its stones
  on the board plus the empty regions it surrounds alone. White receives
  **komi** (5.5 on 9x9) as compensation for moving second; the half point
  prevents draws.

That is essentially the whole game — the depth is in the strategy, not
the rules.

## Learning more

- [Sensei's Library](https://senseis.xmp.net/) — the standard Go wiki;
  rules, terminology, and strategy at every level.
- [Online-Go.com learn section](https://online-go.com/learn) — free
  interactive tutorials and a way to play against people of any strength.
- ["The Interactive Way To Go"](https://playgo.to/iwtg/en/) — a classic
  step-by-step interactive tutorial for complete beginners.
