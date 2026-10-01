"use strict";
// Local server for Jev Go.
// Serves static files and answers POST /jev from either TypeSafe System One
// or a local Ollama decision model.
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_PROXY_BODY = 262144; // 256 KB
const PROXY_TIMEOUT = 15000;
const OLLAMA_TIMEOUT = 30000;
const TS_HOST = "api.typesafe.ai";
const TS_PATH = "/v1/systemone";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_URL = new URL(OLLAMA_HOST);
const EXPLICIT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || "";
const OLLAMA_MAX_CHOICE_CANDIDATES = 26;
const OLLAMA_QUESTIONS_PER_BATCH = 44;
const MIN_OLLAMA_CONTEXT = 8192;
let ollamaModel = EXPLICIT_OLLAMA_MODEL;
let ollamaVersion = "";
let nativeDecisions = null;

if (OLLAMA_URL.protocol !== "http:" && OLLAMA_URL.protocol !== "https:") {
  throw new Error("OLLAMA_HOST must use http:// or https://");
}

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".md": "text/markdown",
};

const ROOT = __dirname;

function readDotEnvApiKey() {
  try {
    const lines = fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || (match[1] !== "TYPESAFE_API_KEY" && match[1] !== "TYPESAFEAI_API_KEY")) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "").trim();
      }
      if (value) return value;
    }
  } catch (e) {}
  return "";
}

const ENV_KEY = process.env.TYPESAFE_API_KEY || process.env.TYPESAFEAI_API_KEY || readDotEnvApiKey();

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendUpstreamError(res, error, detail) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const timedOut = /timed out/i.test(detail);
  sendJson(res, timedOut ? 504 : 502, { error: timedOut ? "proxy_timeout" : error, detail });
}

function bindUpstream(res, upstream, timeoutMs = PROXY_TIMEOUT) {
  const abort = () => upstream.destroy();
  const timeout = setTimeout(() => {
    upstream.destroy(new Error("upstream timed out after " + timeoutMs + "ms"));
  }, timeoutMs);
  res.once("close", abort);
  upstream.once("close", () => {
    clearTimeout(timeout);
    res.off("close", abort);
  });
}

function readBody(req, res, onBody) {
  const chunks = [];
  let size = 0;
  let done = false;
  req.on("data", chunk => {
    if (done) return;
    size += chunk.length;
    if (size > MAX_PROXY_BODY) {
      done = true;
      chunks.length = 0;
      sendJson(res, 413, { error: "payload_too_large", limitBytes: MAX_PROXY_BODY });
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!done) onBody(Buffer.concat(chunks));
  });
  req.on("error", error => {
    if (done) return;
    done = true;
    sendJson(res, 400, { error: "bad_request", detail: String(error.message) });
  });
}

function hasAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!req.headers.host) return false;
  try {
    return new URL(origin).origin === new URL("http://" + req.headers.host).origin;
  } catch (e) {
    return false;
  }
}

function serveStatic(req, res) {
  const url = req.url === "/" ? "/jev-go.html" : req.url.split("?")[0];
  let file;
  try {
    file = path.resolve(ROOT, "." + decodeURIComponent(url));
  } catch (e) {
    file = "";
  }
  const relative = file ? path.relative(ROOT, file) : "";
  const hidden = relative.split(path.sep).some(part => part.startsWith("."));
  if (!file || !relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || hidden) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": data.length,
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

function proxyTypeSafe(req, res) {
  readBody(req, res, body => {
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    const auth = req.headers.authorization;
    if (auth) headers.Authorization = auth;
    else if (ENV_KEY) headers.Authorization = "Bearer " + ENV_KEY;

    const upstream = https.request(
      { host: TS_HOST, path: TS_PATH, method: "POST", headers },
      up => {
        res.writeHead(up.statusCode || 502, {
          "Content-Type": up.headers["content-type"] || "application/json",
        });
        up.pipe(res);
      }
    );
    bindUpstream(res, upstream);
    upstream.on("error", error => {
      sendUpstreamError(res, "proxy_error", String(error.message));
    });
    upstream.end(body);
  });
}

function ollamaRequest(method, requestPath, body, onReply) {
  const isTls = OLLAMA_URL.protocol === "https:";
  const lib = isTls ? https : http;
  const headers = {};
  if (body) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  const request = lib.request({
    hostname: OLLAMA_URL.hostname,
    port: OLLAMA_URL.port || (isTls ? 443 : 11434),
    path: requestPath,
    method,
    headers,
  }, onReply);
  request.on("error", () => {});
  if (body) request.end(body);
  else request.end();
  return request;
}

function ollamaJson(method, requestPath, body, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const request = ollamaRequest(method, requestPath, body, up => {
      const chunks = [];
      up.on("data", chunk => chunks.push(chunk));
      up.on("end", () => {
        let data = {};
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch (error) {
          reject(new Error("invalid JSON from Ollama"));
          return;
        }
        resolve({ status: up.statusCode || 0, data });
      });
    });
    const timeout = setTimeout(() => request.destroy(new Error("Ollama discovery timed out")), timeoutMs);
    request.once("close", () => clearTimeout(timeout));
    request.once("error", reject);
  });
}

function criteriaNames(criteria) {
  if (Array.isArray(criteria)) return criteria.map(String);
  if (criteria && typeof criteria === "object") return Object.keys(criteria);
  return [];
}

function peakedProbabilities(names, choice) {
  const probabilities = {};
  const rest = names.filter(name => name !== choice);
  probabilities[choice] = rest.length ? 0.5 : 1;
  const share = rest.length ? 0.5 / rest.length : 0;
  for (const name of rest) probabilities[name] = share;
  return probabilities;
}

function buildChatRequest(jevRequest) {
  const questions = jevRequest.questions;
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    throw new Error("questions must be an object");
  }
  const properties = {};
  const required = [];
  const prompt = [];
  for (const [name, question] of Object.entries(questions)) {
    if (!question || typeof question !== "object") throw new Error("invalid question " + name);
    required.push(name);
    if (question.type === "choice") {
      const names = criteriaNames(question.criteria);
      if (!names.length) throw new Error("choice question " + name + " has no criteria");
      properties[name] = { type: "string", enum: names };
      prompt.push(name + " (choice): " + question.instructions + " Allowed: " + names.join(", ") + ".");
    } else if (question.type === "noul") {
      properties[name] = { type: "number", minimum: 0, maximum: 1 };
      prompt.push(name + " (probability 0..1 that the answer is true): " + question.instructions);
    } else if (question.type === "score") {
      const maximum = Math.max(0, criteriaNames(question.criteria).length - 1);
      properties[name] = { type: "number", minimum: 0, maximum };
      prompt.push(name + " (score 0.." + maximum + "): " + question.instructions);
    } else {
      throw new Error("unsupported question type " + question.type);
    }
  }
  return {
    model: ollamaModel,
    stream: false,
    think: false,
    messages: [
      {
        role: "system",
        content:
          "You are a typed decision model. Evaluate every requested field independently and return exactly one JSON object matching the schema. " +
          "Do not omit fields or add commentary.\n" + prompt.join("\n"),
      },
      { role: "user", content: String(jevRequest.state || "") },
    ],
    format: { type: "object", properties, required },
    options: {
      num_predict: Math.min(4096, Math.max(256, required.length * 16)),
      num_ctx: 16384,
      temperature: 0.2,
    },
  };
}

function adaptChatReply(jevRequest, reply) {
  let values;
  try {
    values = JSON.parse(reply.message && reply.message.content || "{}");
  } catch (error) {
    throw new Error("chat model returned invalid JSON");
  }
  const answers = {};
  for (const [name, question] of Object.entries(jevRequest.questions)) {
    const value = values[name];
    if (question.type === "choice") {
      const names = criteriaNames(question.criteria);
      if (!names.includes(value)) throw new Error("chat model returned an invalid choice for " + name);
      answers[name] = {
        choice: value,
        confidence: 0.9,
        probabilities: peakedProbabilities(names, value),
      };
    } else if (question.type === "noul") {
      if (!Number.isFinite(value)) throw new Error("chat model omitted Noul " + name);
      answers[name] = { noul: Math.max(0, Math.min(1, value)) };
    } else if (question.type === "score") {
      if (!Number.isFinite(value)) throw new Error("chat model omitted Score " + name);
      const maximum = Math.max(0, criteriaNames(question.criteria).length - 1);
      answers[name] = { type: "score", score: Math.max(0, Math.min(maximum, value)) };
    }
  }
  return {
    model: ollamaModel,
    answers,
    usage: {
      input_tokens: Number(reply.prompt_eval_count || 0),
      output_tokens: Number(reply.eval_count || 0),
    },
  };
}

function chatAdapted(jevRequest, res) {
  let chatRequest;
  try {
    chatRequest = buildChatRequest(jevRequest);
  } catch (error) {
    sendJson(res, 400, { error: "bad_request", detail: String(error.message) });
    return;
  }
  const body = JSON.stringify(chatRequest);
  const upstream = ollamaRequest("POST", "/api/chat", body, up => {
    const chunks = [];
    up.on("data", chunk => chunks.push(chunk));
    up.on("end", () => {
      if (up.statusCode !== 200) {
        sendJson(res, 502, { error: "ollama_error", detail: "HTTP " + up.statusCode });
        return;
      }
      let reply;
      try {
        reply = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        sendJson(res, 200, adaptChatReply(jevRequest, reply));
      } catch (error) {
        sendJson(res, 502, { error: "ollama_error", detail: String(error.message) });
      }
    });
  });
  bindUpstream(res, upstream, OLLAMA_TIMEOUT);
  upstream.on("error", error => {
    sendUpstreamError(res, "ollama_error", String(error.message));
  });
}

function mergeDecisionReplies(replies) {
  const merged = {
    model: replies.find(reply => reply.model)?.model || ollamaModel,
    answers: {},
    usage: {},
  };
  for (const reply of replies) {
    Object.assign(merged.answers, reply.answers || {});
    for (const [name, value] of Object.entries(reply.usage || {})) {
      if (Number.isFinite(value)) merged.usage[name] = (merged.usage[name] || 0) + value;
    }
  }
  return merged;
}

function prepareNativeQuestions(questions) {
  const expanded = {};
  const splitChoices = [];
  for (const [name, question] of Object.entries(questions)) {
    const criteria = criteriaNames(question && question.criteria);
    if (!question || question.type !== "choice" || criteria.length <= OLLAMA_MAX_CHOICE_CANDIDATES) {
      expanded[name] = question;
      continue;
    }
    const parts = [];
    for (let i = 0; i < criteria.length; i += OLLAMA_MAX_CHOICE_CANDIDATES) {
      const partName = name + "__part_" + (parts.length + 1);
      const names = criteria.slice(i, i + OLLAMA_MAX_CHOICE_CANDIDATES);
      const partCriteria = Object.fromEntries(names.map(candidate => [
        candidate,
        Array.isArray(question.criteria) ? null : question.criteria[candidate],
      ]));
      expanded[partName] = { ...question, criteria: partCriteria };
      parts.push(partName);
    }
    splitChoices.push({ name, parts });
  }
  return { expanded, splitChoices };
}

function collapseSplitChoices(reply, splitChoices) {
  for (const split of splitChoices) {
    const probabilities = {};
    let confidence = 0;
    const partAnswers = split.parts.map(partName => {
      const answer = reply.answers[partName];
      if (!answer || !answer.probabilities) throw new Error("Ollama omitted split Choice " + partName);
      return { partName, answer };
    });
    const candidateCount = partAnswers.reduce(
      (total, part) => total + Object.keys(part.answer.probabilities).length,
      0
    );
    for (const { partName, answer } of partAnswers) {
      confidence = Math.max(confidence, Number(answer.confidence || 0));
      const partWeight = Object.keys(answer.probabilities).length / candidateCount;
      for (const [candidate, probability] of Object.entries(answer.probabilities)) {
        probabilities[candidate] = probability * partWeight;
      }
      delete reply.answers[partName];
    }
    const choice = Object.entries(probabilities)
      .reduce((best, entry) => entry[1] > best[1] ? entry : best)[0];
    reply.answers[split.name] = { type: "choice", choice, confidence, probabilities };
  }
  return reply;
}

function postNativeBatch(jevRequest, questions, activeRequests) {
  const body = JSON.stringify({ ...jevRequest, model: ollamaModel, questions });
  return new Promise((resolve, reject) => {
    const upstream = ollamaRequest("POST", "/v1/systemone", body, up => {
      const chunks = [];
      up.on("data", chunk => chunks.push(chunk));
      up.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data;
        try {
          data = JSON.parse(text || "{}");
        } catch (error) {
          reject(new Error("invalid JSON from Ollama /v1/systemone"));
          return;
        }
        resolve({ status: up.statusCode || 0, data });
      });
    });
    activeRequests.push(upstream);
    const timeout = setTimeout(() => {
      upstream.destroy(new Error("upstream timed out after " + OLLAMA_TIMEOUT + "ms"));
    }, OLLAMA_TIMEOUT);
    upstream.once("close", () => clearTimeout(timeout));
    upstream.once("error", reject);
  });
}

function handleAdaptedNative(jevRequest, res) {
  const prepared = prepareNativeQuestions(jevRequest.questions);
  const entries = Object.entries(prepared.expanded);
  const batches = [];
  for (let i = 0; i < entries.length; i += OLLAMA_QUESTIONS_PER_BATCH) {
    batches.push(Object.fromEntries(entries.slice(i, i + OLLAMA_QUESTIONS_PER_BATCH)));
  }
  const activeRequests = [];
  const abort = () => {
    for (const request of activeRequests) request.destroy();
  };
  res.once("close", abort);
  Promise.all(batches.map(questions => postNativeBatch(jevRequest, questions, activeRequests)))
    .then(replies => {
      res.off("close", abort);
      const unavailable = replies.some(reply => reply.status === 404);
      if (unavailable) {
        nativeDecisions = false;
        chatAdapted(jevRequest, res);
        return;
      }
      const failure = replies.find(reply => reply.status < 200 || reply.status >= 300);
      if (failure) {
        sendJson(res, failure.status || 502, failure.data);
        return;
      }
      nativeDecisions = true;
      const merged = mergeDecisionReplies(replies.map(reply => reply.data));
      sendJson(res, 200, collapseSplitChoices(merged, prepared.splitChoices));
    })
    .catch(error => {
      res.off("close", abort);
      sendUpstreamError(res, "ollama_error", String(error.message));
    });
}

function handleOllama(req, res) {
  readBody(req, res, rawBody => {
    let jevRequest;
    try {
      jevRequest = JSON.parse(rawBody.toString("utf8"));
    } catch (error) {
      sendJson(res, 400, { error: "bad_request", detail: "invalid JSON" });
      return;
    }
    if (nativeDecisions === false) {
      chatAdapted(jevRequest, res);
      return;
    }
    const questions = jevRequest.questions && Object.values(jevRequest.questions);
    const needsAdaptation = questions && (
      questions.length > OLLAMA_QUESTIONS_PER_BATCH ||
      questions.some(question => question && question.type === "choice" &&
        criteriaNames(question.criteria).length > OLLAMA_MAX_CHOICE_CANDIDATES)
    );
    if (needsAdaptation) {
      handleAdaptedNative(jevRequest, res);
      return;
    }
    jevRequest.model = ollamaModel;
    const body = JSON.stringify(jevRequest);
    const upstream = ollamaRequest("POST", "/v1/systemone", body, up => {
      if (up.statusCode === 404) {
        nativeDecisions = false;
        up.resume();
        chatAdapted(jevRequest, res);
        return;
      }
      if (up.statusCode >= 200 && up.statusCode < 300) nativeDecisions = true;
      res.writeHead(up.statusCode || 502, {
        "Content-Type": up.headers["content-type"] || "application/json",
      });
      up.pipe(res);
    });
    bindUpstream(res, upstream, OLLAMA_TIMEOUT);
    upstream.on("error", error => {
      sendUpstreamError(res, "ollama_error", String(error.message));
    });
  });
}

async function detectOllama() {
  if (ollamaModel || ENV_KEY) return;
  let models = [];
  try {
    const response = await ollamaJson("GET", "/api/tags", null);
    models = response.status === 200 && response.data.models || [];
    for (const model of models) {
      try {
        const details = await ollamaJson("POST", "/api/show", JSON.stringify({ model: model.name }));
        const match = details.data && String(details.data.parameters || "").match(/num_ctx\s+(\d+)/);
        if (match && Number(match[1]) >= MIN_OLLAMA_CONTEXT) {
          ollamaModel = model.name;
          break;
        }
      } catch (error) {}
    }
  } catch (error) {}
  if (!ollamaModel && models[0]) ollamaModel = models[0].name;
}

async function fetchOllamaVersion() {
  try {
    const response = await ollamaJson("GET", "/api/version", null);
    if (response.status === 200 && response.data.version) ollamaVersion = response.data.version;
  } catch (error) {}
}

function warmOllama() {
  const body = JSON.stringify({
    model: ollamaModel,
    state: "warm-up",
    questions: {
      move: { type: "choice", instructions: "Pick one.", criteria: { a: "first", b: "second" } },
      pass_ok: {
        type: "noul",
        instructions: "Is passing sound?",
        criteria: { true: "Passing is sound.", false: "Passing is not sound." },
      },
      quality_a: { type: "score", instructions: "Rate a.", criteria: ["bad", "ok", "good"] },
    },
  });
  const request = ollamaRequest("POST", "/v1/systemone", body, up => {
    nativeDecisions = up.statusCode === 200;
    console.log(nativeDecisions
      ? "Decision mode: native /v1/systemone"
      : "Decision mode: chat adapter (native endpoint unavailable)");
    up.resume();
    if (!nativeDecisions) {
      const chatBody = JSON.stringify({
        model: ollamaModel,
        stream: false,
        think: false,
        messages: [{ role: "user", content: "Reply OK." }],
        options: { num_predict: 2 },
      });
      ollamaRequest("POST", "/api/chat", chatBody, reply => reply.resume());
    }
  });
  request.once("error", error => {
    nativeDecisions = false;
    console.warn("Ollama warm-up failed: " + error.message);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/jev") {
    if (!hasAllowedOrigin(req)) {
      sendJson(res, 403, { error: "forbidden_origin", detail: "POST /jev requires the same origin" });
      return;
    }
    if (ollamaModel) return handleOllama(req, res);
    return proxyTypeSafe(req, res);
  }
  if (req.method === "GET" && req.url === "/jevstatus") {
    sendJson(res, 200, {
      serverKey: !!ENV_KEY || !!ollamaModel,
      backend: ollamaModel ? "ollama:" + ollamaModel : "typesafe",
      mode: ollamaModel ? (nativeDecisions === null ? "probing" : nativeDecisions ? "native" : "chat") : "typesafe",
      version: ollamaVersion,
    });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  res.writeHead(405, { "Content-Type": "text/plain", "Allow": "GET, HEAD, POST" });
  res.end("405 Method Not Allowed");
});
server.requestTimeout = PROXY_TIMEOUT;
server.headersTimeout = 5000;

async function start() {
  await detectOllama();
  if (ollamaModel) await fetchOllamaVersion();
  server.listen(PORT, HOST, () => {
    console.log("Jev Go");
    console.log("Open http://localhost:" + PORT);
    if (ollamaModel) {
      const source = EXPLICIT_OLLAMA_MODEL ? "configured" : "auto-detected";
      console.log("AI backend: Ollama model " + ollamaModel + " (" + source + ") at " + OLLAMA_HOST);
      if (ollamaVersion) console.log("Ollama version: " + ollamaVersion);
      warmOllama();
    } else if (ENV_KEY) {
      console.log("AI backend: TypeSafe Jev via " + TS_HOST + TS_PATH);
    } else {
      console.log("AI backend: local heuristic (no TypeSafe key or Ollama model found)");
    }
    console.log("Listening on " + HOST + " (set HOST=0.0.0.0 for LAN access)");
  });
}

start().catch(error => {
  console.error("Server failed: " + (error.message || String(error)));
  process.exitCode = 1;
});
