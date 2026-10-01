# Ollama — recommended local decision AI

Ollama is the recommended way to run Jev Go's decision AI. It needs no
API key and keeps board positions on the configured host. Interactive
play uses a complete typed Choice plus a Noul pass gate; TypeSafe adds
an exhaustive Score for every legal action. TypeSafe remains available
as the cloud alternative.

## Prerequisites

1. Install Node.js 18 or newer.
2. Install and start Ollama.
3. Pull a decision model, for example:

```sh
ollama pull nimble:latest
```

Ollama 0.35 or newer is recommended. Its native `/v1/systemone`
endpoint supplies the Choice probabilities and Noul probability used by
interactive play.

## Start

With no TypeSafe key configured, `node server.js` auto-detects the first
installed Ollama model whose configured context is at least 16384 tokens
(falling back to the first model when none advertises that size):

```sh
node server.js
```

Select a model explicitly with `OLLAMA_MODEL`:

```sh
# Windows PowerShell
$env:OLLAMA_MODEL="nimble-go"; node server.js

# Windows cmd.exe
set "OLLAMA_MODEL=nimble-go" && node server.js

# macOS / Linux
OLLAMA_MODEL=nimble-go node server.js
```

Open **http://localhost:3000**. The HUD names the model, Ollama version,
and decision mode.

The stock `nimble:latest` model is configured for only 8194 tokens. That
is enough for sparse positions but dense tactical positions can exceed
it. Create a Go-specific 16K variant once to avoid position-dependent
HTTP 400 responses:

```text
FROM nimble:latest
PARAMETER num_ctx 16384
```

Save those lines as `Nimble.Go.Modelfile`, then run:

```sh
ollama create nimble-go -f Nimble.Go.Modelfile
```

Start the game with `OLLAMA_MODEL=nimble-go`. This changes only the
loaded context; it uses the same Nimble weights.

## Backend selection

The server uses this precedence:

1. Explicit `OLLAMA_MODEL`
2. `TYPESAFE_API_KEY` or `TYPESAFEAI_API_KEY`
3. First context-compatible installed Ollama model, auto-detected when no
   TypeSafe key exists
4. Built-in local heuristic when neither decision backend is available

A browser key entered with **J** is used only by the TypeSafe path. An
explicit Ollama model therefore prevents a browser key from sending the
position to TypeSafe.

`OLLAMA_HOST` selects another Ollama instance and supports both HTTP and
HTTPS:

```sh
OLLAMA_HOST=http://192.168.1.20:11434 OLLAMA_MODEL=nimble:latest node server.js
```

The game server still binds to `127.0.0.1` unless `HOST=0.0.0.0` is set.

## Decision modes

### Native mode

On Ollama 0.35+, interactive play sends one Choice over every legal
action plus one Noul pass gate to Ollama's `/v1/systemone`:

```text
browser POST /jev -> server -> Ollama /v1/systemone
                  <- Choice + Noul <-
```

This preserves Ollama's real Choice probabilities, confidence, and Noul
probability. Ollama limits one Choice to 26 candidates, while Go needs
up to 82 actions. The proxy splits the Choice into 26-option parts and
recombines their normalized probabilities; no legal move is dropped.
Avoiding 82 separate Score questions cuts a first-turn request from
about 524K aggregate input tokens to about 16K and reduced the measured
local response from 14.5 seconds to 1.5 seconds. The server also sends a
small multi-output warm-up request at startup.

The proxy still accepts the full Choice/Noul/Score contract, and the
benchmark runner can use it for controlled experiments. The lightweight
interactive path is specific to browser play through Ollama. TypeSafe
interactive play retains exhaustive candidate Scores.

### Chat-adapter mode

If `/v1/systemone` is unavailable, the server converts all typed
questions into one JSON-schema-constrained `/api/chat` request. It
requires a value for every field, then reshapes the result into the Jev
response format. Choice probabilities are synthetic in this mode; Noul
and Score values come from the chat model. Missing or invalid fields
produce an explicit `502` rather than a partial success.

Native decision mode is strongly preferred for speed and fidelity.

## Verify

Status:

```sh
curl http://localhost:3000/jevstatus
```

Example:

```json
{"serverKey":true,"backend":"ollama:nimble:latest","mode":"native","version":"0.35.0"}
```

The server accepts the full request shape documented in
[README.md](README.md#how-it-works). Press **L** in game to inspect
choices, confidence, probabilities, and pass judgments. Ollama
interactive entries have `scores: null`; TypeSafe entries include
per-candidate Scores.

## Benchmarking

The retained color-balanced runner can call Ollama directly:

```sh
node benchmark.js --pairs 10 --ollama-model nimble:latest
```

Use `--ollama-host URL` for a non-default instance. `OLLAMA_MODEL` and
`OLLAMA_HOST` provide the same defaults as the server. The benchmark
requires native `/v1/systemone`; it deliberately does not use the chat
adapter because native and synthetic probabilities are not equivalent.
Each game record includes `decisionBackend`.

## Troubleshooting

- **HUD says Local AI:** start Ollama, pull at least one model, and restart
  `node server.js`; inspect `/jevstatus`.
- **Mode is `chat`:** update Ollama to 0.35+ and use a decision-capable
  model.
- **HTTP 400 mentioning context or tokens:** the model's configured
  context is too small for the current position. Dense tactical positions
  need more than the stock Nimble model's 8194 tokens. Create the 16K
  `nimble-go` variant above or use another model configured for at least
  16384 tokens.
- **HTTP 504:** the model exceeded the 30-second local deadline. Use a
  faster model or allow it to warm before playing.
- **HTTP 502 in chat mode:** the model failed to return every required
  Choice, Noul, and Score field. Native mode is more reliable.
- **Wrong model selected:** set `OLLAMA_MODEL` explicitly. Auto-detection
  chooses the first installed model advertising at least an 8192-token
  context.
