# Local decision AI with Ollama

Jev Go can use a local [Ollama](https://ollama.com) decision model for
White instead of the TypeSafe Jev API. No API key is required, and model
requests stay on the configured Ollama host.

## Prerequisites

1. Install Node.js 18 or newer.
2. Install and start Ollama.
3. Pull a decision model, for example:

```sh
ollama pull nimble:latest
```

Ollama 0.35 or newer is recommended. Its native `/v1/systemone`
endpoint supports the same typed request used by this game: one `Choice`,
one `Noul`, and a `Score` for every legal point plus pass.

## Start

With no TypeSafe key configured, `node server.js` auto-detects the first
installed Ollama model whose configured context is at least 8192 tokens
(falling back to the first model when none advertises that size):

```sh
node server.js
```

Select a model explicitly with `OLLAMA_MODEL`:

```sh
# Windows PowerShell
$env:OLLAMA_MODEL="nimble:latest"; node server.js

# Windows cmd.exe
set "OLLAMA_MODEL=nimble:latest" && node server.js

# macOS / Linux
OLLAMA_MODEL=nimble:latest node server.js
```

Open **http://localhost:3000**. The HUD names the model, Ollama version,
and decision mode.

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

On Ollama 0.35+, the server replaces the request's `model` field and
forwards the otherwise unchanged body to Ollama's `/v1/systemone`:

```text
browser POST /jev -> server -> Ollama /v1/systemone
                  <- Choice + Noul + Scores <-
```

This preserves Ollama's real Choice probabilities, confidence, Noul
probability, and expected Scores. Ollama limits one request to 64
questions and one Choice to 26 candidates, while Go needs up to 84
outputs and 82 actions. The proxy therefore uses two context-safe
question batches, splits the Choice into 26-option parts, and recombines
their normalized probabilities. No legal move or Score is dropped. The
server also sends a small multi-output warm-up request at startup.

### Chat-adapter mode

If `/v1/systemone` is unavailable, the server converts all typed
questions into one JSON-schema-constrained `/api/chat` request. It
requires a value for every field, then reshapes the result into the Jev
response format. Choice probabilities are synthetic in this mode; Noul
and Score values come from the chat model. Missing or invalid fields
produce an explicit `502` rather than a partial success.

Go can request up to 84 outputs, so native decision mode is strongly
preferred for speed and fidelity.

## Verify

Status:

```sh
curl http://localhost:3000/jevstatus
```

Example:

```json
{"serverKey":true,"backend":"ollama:nimble:latest","mode":"native","version":"0.35.0"}
```

The server accepts the same full request shape documented in
[README.md](README.md#how-it-works). Press **L** in game to inspect
choices, confidence, probabilities, pass judgments, and Scores.

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
- **HTTP 400 mentioning tokens:** the model's configured context is too
  small for Go's roughly 8K-token empty-board prompt. Use `nimble:latest`
  or another model configured for at least 8192 tokens.
- **HTTP 504:** the model exceeded the 30-second local deadline. Use a
  faster model or allow it to warm before playing.
- **HTTP 502 in chat mode:** the model failed to return every required
  Choice, Noul, and Score field. Native mode is more reliable.
- **Wrong model selected:** set `OLLAMA_MODEL` explicitly. Auto-detection
  chooses the first installed model advertising at least an 8192-token
  context.
