"use strict";

const MAX_CHOICE_CANDIDATES = 26;
const QUESTIONS_PER_BATCH = 44;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isContent(value) {
  return (typeof value === "string" && value.trim().length > 0) ||
    (value !== null && typeof value === "object");
}

function validateDecisionRequest(request) {
  if (!isObject(request)) throw new Error("request must be an object");
  if (!isContent(request.state)) throw new Error("state must be nonempty text, an object, or an array");
  if (!isObject(request.questions) || !Object.keys(request.questions).length) {
    throw new Error("questions must be a nonempty object");
  }
  for (const [name, question] of Object.entries(request.questions)) {
    if (!name.trim() || !isObject(question) || !isContent(question.instructions)) {
      throw new Error("invalid question " + name);
    }
    const criteria = question.criteria;
    if (question.type === "choice") {
      if (!isObject(criteria) || Object.keys(criteria).length < 2 ||
          Object.entries(criteria).some(([key, value]) => !key.trim() || (value !== null && typeof value !== "string"))) {
        throw new Error("Choice " + name + " requires at least two named criteria with text or null descriptions");
      }
    } else if (question.type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 26 ||
          criteria.some(value => typeof value !== "string")) {
        throw new Error("Score " + name + " requires 2-26 text criteria");
      }
    } else if (question.type === "noul") {
      if (criteria !== undefined && (!isObject(criteria) ||
          Object.entries(criteria).some(([key, value]) => !["true", "false"].includes(key) || typeof value !== "string"))) {
        throw new Error("invalid Noul criteria for " + name);
      }
    } else {
      throw new Error("unsupported question type for " + name);
    }
  }
}

class OllamaHttpError extends Error {
  constructor(status, data) {
    data = isObject(data) ? data : { error: "invalid error response from Ollama" };
    super("Ollama HTTP " + status + ": " + (data.detail || data.error || "request failed"));
    this.status = status;
    this.data = data;
  }
}

function addReply(target, reply) {
  if (!isObject(reply) || !isObject(reply.answers)) throw new Error("Ollama omitted answers");
  Object.assign(target.answers, reply.answers);
  if (reply.model) target.model = reply.model;
  for (const [name, value] of Object.entries(reply.usage || {})) {
    if (Number.isFinite(value)) target.usage[name] = (target.usage[name] || 0) + value;
  }
}

function choiceWinner(answer, criteria) {
  const names = Object.keys(criteria);
  if (!answer || !names.includes(answer.choice) || !isObject(answer.probabilities) ||
      names.some(name => !Number.isFinite(answer.probabilities[name]) ||
        answer.probabilities[name] < 0 || answer.probabilities[name] > 1) ||
      !names.some(name => answer.probabilities[name] > 0)) {
    throw new Error("Ollama returned an invalid Choice answer");
  }
  return names.reduce((best, name) => answer.probabilities[name] > answer.probabilities[best] ? name : best);
}

// Independent Choice distributions cannot be averaged into a global one.
// Evaluate every candidate in round one, then compare the winners directly.
async function runNativeDecision(request, post) {
  validateDecisionRequest(request);
  const expanded = Object.create(null);
  const tournaments = [];
  const usedNames = new Set(Object.keys(request.questions));
  let serial = 0;
  for (const [name, question] of Object.entries(request.questions)) {
    const names = question.type === "choice" ? Object.keys(question.criteria) : [];
    if (names.length <= MAX_CHOICE_CANDIDATES) {
      expanded[name] = question;
      continue;
    }
    const partCount = Math.ceil(names.length / MAX_CHOICE_CANDIDATES);
    const parts = [];
    for (let i = 0; i < partCount; i++) {
      let partName;
      do { partName = "__choice_round_" + serial++; } while (usedNames.has(partName));
      usedNames.add(partName);
      const candidates = names.slice(Math.floor(i * names.length / partCount), Math.floor((i + 1) * names.length / partCount));
      const criteria = Object.fromEntries(candidates.map(candidate => [candidate, question.criteria[candidate]]));
      expanded[partName] = { ...question, criteria };
      parts.push(partName);
    }
    tournaments.push({ name, question, parts, count: names.length });
  }
  const entries = Object.entries(expanded);
  const batches = [];
  for (let i = 0; i < entries.length; i += QUESTIONS_PER_BATCH) {
    batches.push({ ...request, questions: Object.fromEntries(entries.slice(i, i + QUESTIONS_PER_BATCH)) });
  }
  const replies = await Promise.all(batches.map(async batch => {
    const reply = await post(batch);
    if (reply.status < 200 || reply.status >= 300) throw new OllamaHttpError(reply.status, reply.data);
    if (!isObject(reply.data) || !isObject(reply.data.answers)) throw new Error("Ollama omitted answers");
    for (const [name, question] of Object.entries(batch.questions)) {
      const answer = reply.data.answers && reply.data.answers[name];
      if (!answer) throw new Error("Ollama omitted answer " + name);
      if (question.type === "choice") choiceWinner(answer, question.criteria);
    }
    return reply.data;
  }));
  const merged = { model: request.model, answers: Object.create(null), usage: {} };
  replies.forEach(reply => addReply(merged, reply));
  if (tournaments.length) {
    const finals = Object.fromEntries(tournaments.map(({ name, question, parts }) => {
      const winners = parts.map(part => choiceWinner(merged.answers[part], expanded[part].criteria));
      for (const part of parts) delete merged.answers[part];
      return [name, { ...question, criteria: Object.fromEntries(winners.map(winner => [winner, question.criteria[winner]])) }];
    }));
    addReply(merged, await runNativeDecision({ ...request, questions: finals }, post));
    for (const { name, count } of tournaments) {
      Object.assign(merged.answers[name], {
        selection: "tournament",
        probabilityScope: "finalists",
        candidatesEvaluated: count,
      });
    }
  }
  return merged;
}

module.exports = { validateDecisionRequest, runNativeDecision, OllamaHttpError };
