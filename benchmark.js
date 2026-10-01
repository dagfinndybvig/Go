#!/usr/bin/env node
'use strict';

// Paired, color-balanced 9x9 matches using the game's rules and Jev policy.
// Usage: node benchmark.js --pairs 10 --opponents greedy,noise25,random

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DEFAULT_MAX_TURNS = 600;
const DEFAULT_OPPONENTS = ['greedy'];

function parseArgs(argv) {
  const out = {
    pairs: 1, seed: 1, maxTurns: DEFAULT_MAX_TURNS, opponents: DEFAULT_OPPONENTS,
    output: null, katagoBin: process.env.KATAGO_BIN || 'katago',
    katagoModel: process.env.KATAGO_MODEL || '',
    katagoHumanModel: process.env.KATAGO_HUMAN_MODEL || '',
    katagoConfig: process.env.KATAGO_CONFIG || '', help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--pairs') out.pairs = Number(argv[++i]);
    else if (arg === '--seed') out.seed = Number(argv[++i]);
    else if (arg === '--max-turns') out.maxTurns = Number(argv[++i]);
    else if (arg === '--opponents') out.opponents = String(argv[++i]).split(',').filter(Boolean);
    else if (arg === '--output') out.output = argv[++i];
    else if (arg === '--katago-bin') out.katagoBin = argv[++i];
    else if (arg === '--katago-model') out.katagoModel = argv[++i];
    else if (arg === '--katago-human-model') out.katagoHumanModel = argv[++i];
    else if (arg === '--katago-config') out.katagoConfig = argv[++i];
    else throw new Error('Unknown argument: ' + arg);
  }
  if (!out.help && (!Number.isInteger(out.pairs) || out.pairs < 1)) throw new Error('--pairs must be a positive integer');
  if (!out.help && (!Number.isInteger(out.seed) || out.seed < 0)) throw new Error('--seed must be a non-negative integer');
  if (!out.help && (!Number.isInteger(out.maxTurns) || out.maxTurns < 2)) throw new Error('--max-turns must be an integer >= 2');
  const known = new Set(['choice-only', 'greedy', 'noise25', 'noise50', 'random', 'katago-5k']);
  if (!out.help && (!out.opponents.length || out.opponents.some(name => !known.has(name)))) {
    throw new Error('Opponents must be selected from: ' + [...known].join(', '));
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node benchmark.js [options]

Run Jev against fixed local opponent anchors. Every pair is two games from
the same seed, with the players swapping Black and White.

Options:
  --pairs N                 Color-swapped pairs per opponent (default: 1)
  --seed N                  First deterministic seed (default: 1)
  --opponents LIST          Comma-separated: choice-only,greedy,noise25,
                            noise50,random,katago-5k (default: ${DEFAULT_OPPONENTS.join(',')})
  --max-turns N             Ply cap per game (default: 600)
  --output FILE             Write per-game JSONL (default: unique timestamped file);
                            position traces and terminal area margins go to
                            <output>.traces.jsonl
  --katago-bin PATH         KataGo executable (default: KATAGO_BIN or katago)
  --katago-model PATH       KataGo's normal model (default: Homebrew b18 model)
  --katago-human-model PATH Human-SL model (default: KATAGO_HUMAN_MODEL or ~/.local/share/katago/models)
  --katago-config PATH      GTP human config (default: Homebrew gtp_human5k_example.cfg)
  --help                    Show this help

The greedy anchor is rated 1000 by convention. All Elo numbers are local to
this 9x9 ruleset and opponent pool; they are not human or 19x19 ratings.
The optional katago-5k anchor uses KataGo's human-SL rank_5k profile.`);
}

function readApiKey() {
  const fromEnv = process.env.TYPESAFE_API_KEY || process.env.TYPESAFEAI_API_KEY;
  if (fromEnv) return fromEnv;
  let contents;
  try { contents = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch (e) { return ''; }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || (match[1] !== 'TYPESAFE_API_KEY' && match[1] !== 'TYPESAFEAI_API_KEY')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (value) return value;
  }
  return '';
}

function resolveKataGoFiles(options) {
  let share = '';
  try { share = path.join(execFileSync('brew', ['--prefix', 'katago'], { encoding: 'utf8' }).trim(), 'share', 'katago'); } catch (e) {}
  const files = share && fs.existsSync(share) ? fs.readdirSync(share) : [];
  const packagedModel = files.find(file => /^kata1-b18c384nbt-.*\.bin\.gz$/.test(file));
  const model = options.katagoModel || (packagedModel ? path.join(share, packagedModel) : '');
  const config = options.katagoConfig || (share && path.join(share, 'configs', 'gtp_human5k_example.cfg'));
  const userModel = path.join(process.env.HOME || '', '.local', 'share', 'katago', 'models', 'b18c384nbt-humanv0.bin.gz');
  const humanModel = options.katagoHumanModel || userModel;
  for (const [label, file] of [['KataGo normal model', model], ['KataGo human-SL model', humanModel], ['KataGo GTP config', config]]) {
    if (!file || !fs.existsSync(file)) throw new Error(label + ' not found. Set its CLI option or environment variable; see benchmark.js --help.');
  }
  return { model, humanModel, config };
}

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filename);
    input.on('error', reject);
    input.on('data', data => hash.update(data));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

class GtpProcess {
  constructor(command, args) {
    this.child = spawn(command, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.pending = null;
    this.stderr = '';
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => this.receive(line));
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-8000); });
    this.child.on('error', error => this.fail(error));
    this.child.on('close', (code, signal) => this.fail(new Error('KataGo exited (' + (signal || code) + '). ' + this.stderr.trim())));
  }

  receive(line) {
    const pending = this.pending;
    if (!pending) return;
    if (!pending.started) {
      const match = line.match(/^([=?])(\d+)(?:\s(.*))?$/);
      if (!match || Number(match[2]) !== pending.id) return;
      pending.started = true;
      pending.ok = match[1] === '=';
      if (match[3]) pending.response.push(match[3]);
      return;
    }
    if (line === '') {
      this.pending = null;
      clearTimeout(pending.timer);
      if (pending.ok) pending.resolve(pending.response.join('\n').trim());
      else pending.reject(new Error('KataGo GTP error: ' + pending.response.join('\n').trim()));
    } else pending.response.push(line);
  }

  fail(error) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  command(text, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending = { id, resolve, reject, response: [], started: false, ok: false };
      pending.timer = setTimeout(() => {
        if (this.pending === pending) this.pending = null;
        reject(new Error('KataGo timed out on GTP command: ' + text));
      }, timeoutMs);
      this.pending = pending;
      this.child.stdin.write(id + ' ' + text + '\n', error => {
        if (error && this.pending === pending) {
          this.pending = null;
          clearTimeout(pending.timer);
          reject(error);
        }
      });
    });
  }

  async close() {
    if (this.child.exitCode !== null || this.child.killed) return;
    try { await this.command('quit', 5000); } catch (e) { this.child.kill(); }
    await new Promise(resolve => {
      if (this.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 5000);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    this.lines.close();
  }
}

async function startKataGo(options) {
  const files = resolveKataGoFiles(options);
  const engine = new GtpProcess(options.katagoBin, [
    'gtp', '-config', files.config, '-model', files.model, '-human-model', files.humanModel,
  ]);
  try {
    await engine.command('protocol_version');
    const version = await engine.command('version');
    const metadata = {
      version,
      profile: 'rank_5k',
      visits: 1,
      chosenMoveTemperatureEarly: 1,
      chosenMoveTemperature: 1,
      chosenMoveTemperatureOnlyBelowProb: 0,
      humanSLChosenMoveIgnorePass: false,
      allowResignation: false,
      rules: 'Chinese (simple ko, area scoring, suicide illegal)',
      komi: 5.5,
      model: path.basename(files.model),
      modelSha256: await sha256File(files.model),
      humanModel: path.basename(files.humanModel),
      humanModelSha256: await sha256File(files.humanModel),
      config: path.basename(files.config),
    };
    const newGame = async () => {
      await engine.command('boardsize 9');
      await engine.command('komi 5.5');
      await engine.command('kata-set-rules chinese');
      await engine.command('kata-set-param humanSLProfile rank_5k');
      await engine.command('kata-set-param maxVisits 1');
      await engine.command('kata-set-param chosenMoveTemperatureEarly 1.0');
      await engine.command('kata-set-param chosenMoveTemperature 1.0');
      await engine.command('kata-set-param chosenMoveTemperatureOnlyBelowProb 0');
      await engine.command('kata-set-param humanSLChosenMoveIgnorePass false');
      await engine.command('kata-set-param allowResignation false');
      await engine.command('clear_board');
    };
    await newGame();
    return {
      engine, metadata, newGame,
      async genmove(color) {
        const response = await engine.command('genmove ' + (color === 1 ? 'B' : 'W'));
        const move = response.trim().split(/\s+/)[0];
        if (/^pass$/i.test(move)) return { pass: true };
        if (/^resign$/i.test(move)) return { resign: true };
        const match = move.match(/^([A-HJ])([1-9])$/i);
        if (!match) throw new Error('KataGo returned an invalid GTP move: ' + move);
        return { x: 'ABCDEFGHJ'.indexOf(match[1].toUpperCase()), y: Number(match[2]) - 1 };
      },
      async play(color, move) {
        await engine.command('play ' + (color === 1 ? 'B' : 'W') + ' ' + move);
      },
      close: () => engine.close(),
    };
  } catch (error) {
    await engine.close();
    throw error;
  }
}

function loadGame(apiKey) {
  const html = fs.readFileSync(path.join(ROOT, 'jev-go.html'), 'utf8');
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/i);
  if (!match) throw new Error('Could not find the inline game script in jev-go.html');
  const noop = () => {};
  const canvasContext = new Proxy({}, { get: () => noop, set: () => true });
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, style: {}, textContent: '', addEventListener: noop,
      getContext: () => canvasContext,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    });
    return elements.get(id);
  };
  const document = { getElementById: element, addEventListener: noop };
  const math = Object.create(Math);
  let apiRequests = 0;
  const apiUsage = [];
  const trackedFetch = (...args) => { apiRequests++; return fetch(...args); };
  const shim = `
;globalThis.__benchmark = {
  N, EMPTY, BLACK, WHITE, Jev,
  legalMoves, heuristicPick, coordName: Jev.coordName,
  snapshot() {
    return {
      board: board.map(row => row.slice()),
      captures: { ...captures },
      lastMove: lastMove ? lastMove.map(row => row.slice()) : null,
      lastCoord: lastCoord ? { ...lastCoord } : null,
      jevLastChoice, passes, turn, gameOver,
    };
  },
  setState(s) {
    board = s.board.map(row => row.slice());
    captures = { ...s.captures };
    lastMove = s.lastMove ? s.lastMove.map(row => row.slice()) : null;
    lastCoord = s.lastCoord ? { ...s.lastCoord } : null;
    jevLastChoice = s.jevLastChoice || null;
    passes = s.passes || 0;
    turn = s.turn || BLACK;
    gameOver = !!s.gameOver;
  },
};
`;
  const context = {
    document, window: {}, localStorage: { getItem: () => null, setItem: noop },
    location: { hostname: 'benchmark.invalid' },
    fetch: trackedFetch, Math: math, console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, AbortController, AbortSignal,
  };
  vm.runInNewContext(match[1] + shim, context, { filename: 'jev-go.html' });
  const engine = context.__benchmark;
  engine.Jev.setKey(apiKey);
  return {
    engine,
    setRandom(fn) { math.random = fn; },
    clearRandom() { math.random = Math.random; },
    getApiRequests() { return apiRequests; },
    resetApiRequests() { apiRequests = 0; },
    getApiUsage() { return apiUsage; },
    resetApiUsage() { apiUsage.length = 0; },
    recordApiUsage(data) { apiUsage.push({ model: data.model || 'jev-latest', usage: data.usage || {} }); },
    fetch(url, init) { return trackedFetch(url, init); },
    apiKey,
  };
}

function emptyBoard(size) { return Array.from({ length: size }, () => Array(size).fill(0)); }
function copyBoard(board) { return board.map(row => row.slice()); }
function swapColors(board) {
  return board.map(row => row.map(value => value === 1 ? 2 : value === 2 ? 1 : value));
}

function compactState(engine, state) {
  const columns = 'ABCDEFGHJ';
  const lastBlack = state.passes > 0 ? 'pass' : (state.lastCoord ? engine.coordName(state.lastCoord.x, state.lastCoord.y) : 'none');
  const rows = [];
  for (let y = engine.N - 1; y >= 0; y--) {
    let row = (y + 1) + ' ';
    for (let x = 0; x < engine.N; x++) {
      row += state.board[y][x] === engine.BLACK ? 'O' : state.board[y][x] === engine.WHITE ? 'X' : '.';
    }
    rows.push(row);
  }
  return [
    'W=X, B=O; White to play; area scoring; komi 5.5; two consecutive passes end the game.',
    'Captures W/B: ' + state.captures[engine.WHITE] + '/' + state.captures[engine.BLACK] + '; consecutive passes: ' + state.passes + '; last Black: ' + lastBlack + '; last White: ' + (state.jevLastChoice || 'none/pass') + '.',
    'Board (rows 9 to 1; .=empty):',
    rows.join('\n'),
    'Coordinates: columns left-to-right ' + columns.split('').join(' ') + ' (I omitted); rows bottom-to-top 1-9. Choice labels are intersections; pass skips a turn.',
  ].join('\n');
}

// Match the game's area scoring and White komi.
function scoreArea(board, komi = 5.5) {
  const n = board.length, seen = new Set();
  let blackStones = 0, whiteStones = 0, blackTerritory = 0, whiteTerritory = 0;
  for (const row of board) for (const point of row) {
    if (point === 1) blackStones++;
    if (point === 2) whiteStones++;
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const key = x + ',' + y;
    if (board[y][x] !== 0 || seen.has(key)) continue;
    const region = [], stack = [[x, y]], borders = new Set();
    seen.add(key);
    while (stack.length) {
      const [cx, cy] = stack.pop();
      region.push([cx, cy]);
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
        if (nx < 0 || nx >= n || ny < 0 || ny >= n) continue;
        const neighbor = board[ny][nx];
        if (neighbor === 0) {
          const next = nx + ',' + ny;
          if (!seen.has(next)) { seen.add(next); stack.push([nx, ny]); }
        } else borders.add(neighbor);
      }
    }
    if (borders.size === 1) {
      const owner = [...borders][0];
      if (owner === 1) blackTerritory += region.length;
      else whiteTerritory += region.length;
    }
  }
  return {
    black: blackStones + blackTerritory,
    white: whiteStones + whiteTerritory + komi,
  };
}

// Per-point area ownership at game end, row-major flat array: stones belong
// to their color, an empty region belongs to the sole color it touches,
// otherwise 0 (neutral). Sums match scoreArea without komi.
function areaOwnerMap(board) {
  const n = board.length;
  const owner = Array.from({ length: n * n }, () => 0);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) owner[y * n + x] = board[y][x];
  const seen = new Set();
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (board[y][x] !== 0 || seen.has(x + ',' + y)) continue;
      const region = [], stack = [[x, y]], borders = new Set();
      seen.add(x + ',' + y);
      while (stack.length) {
        const [cx, cy] = stack.pop();
        region.push([cx, cy]);
        for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
          if (nx < 0 || nx >= n || ny < 0 || ny >= n) continue;
          const neighbor = board[ny][nx];
          if (neighbor === 0) {
            const next = nx + ',' + ny;
            if (!seen.has(next)) { seen.add(next); stack.push([nx, ny]); }
          } else borders.add(neighbor);
        }
      }
      if (borders.size === 1) {
        const ownerColor = [...borders][0];
        for (const [rx, ry] of region) owner[ry * n + rx] = ownerColor;
      }
    }
  return owner;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashText(value) {
  let hash = 2166136261;
  for (const ch of value) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function randomAnchor(moves, rng) {
  return moves.length ? { move: moves[Math.floor(rng() * moves.length)] } : { pass: true };
}
function makeAnchor(name) {
  if (name === 'choice-only') return { id: 'compact-choice-only', description: 'Earlier compact one-Choice Jev policy.', kind: 'choice-only', noise: 0 };
  if (name === 'greedy') return { id: 'local-greedy', description: 'The game’s current one-ply heuristic.', noise: 0 };
  if (name === 'noise25') return { id: 'local-greedy-25pct-random', description: 'Current heuristic, replaced by a uniform legal move on 25% of turns.', noise: 0.25 };
  if (name === 'noise50') return { id: 'local-greedy-50pct-random', description: 'Current heuristic, replaced by a uniform legal move on 50% of turns.', noise: 0.5 };
  if (name === 'random') return { id: 'uniform-random', description: 'Uniformly random legal moves.', noise: 1 };
  if (name === 'katago-5k') return { id: 'katago-humanSL-rank_5k', description: 'KataGo human-SL 5 kyu policy.', kind: 'katago', noise: 0 };
  throw new Error('Unknown anchor: ' + name);
}

function wilsonInterval(successes, trials, z = 1.96) {
  if (!trials) return [null, null];
  const p = successes / trials, z2 = z * z, denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const radius = z * Math.sqrt(p * (1 - p) / trials + z2 / (4 * trials * trials)) / denom;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}
function eloDifference(scoreRate) {
  if (!(scoreRate > 0 && scoreRate < 1)) return null;
  return 400 * Math.log10(scoreRate / (1 - scoreRate));
}

// Exact two-sided sign test p-value: probability of a result at least as
// lopsided as `successes` vs `failures` under a fair coin.
function binomialCoeff(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return r;
}
function signTestP(successes, failures) {
  const n = successes + failures;
  if (!n) return null;
  const smaller = Math.min(successes, failures);
  let tail = 0;
  for (let k = 0; k <= smaller; k++) tail += binomialCoeff(n, k);
  return Math.min(1, 2 * tail / Math.pow(2, n));
}

function summarize(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.opponent)) groups.set(record.opponent, []);
    groups.get(record.opponent).push(record);
  }
  const output = [];
  for (const [opponent, games] of groups) {
    const ratedGames = games.filter(g => g.result !== 'incomplete');
    const incomplete = games.length - ratedGames.length;
    const wins = ratedGames.filter(g => g.result === 'win').length;
    const losses = ratedGames.filter(g => g.result === 'loss').length;
    const draws = ratedGames.length - wins - losses;
    const score = wins + draws * 0.5;
    const rate = ratedGames.length ? score / ratedGames.length : null;
    const jevBlack = ratedGames.filter(g => g.jevColor === 'black');
    const jevWhite = ratedGames.filter(g => g.jevColor === 'white');
    const blackWins = jevBlack.filter(g => g.result === 'win').length;
    const whiteWins = jevWhite.filter(g => g.result === 'win').length;
    const decisive = wins + losses;
    const ci = draws === 0 ? wilsonInterval(wins, ratedGames.length) : wilsonInterval(score, ratedGames.length);
    const eloBounds = [
      ci[0] === 0 ? -Infinity : eloDifference(ci[0]),
      ci[1] === 1 ? Infinity : eloDifference(ci[1]),
    ];
    // Paired by seed: each pair is Jev-Black + Jev-White against the same
    // seed; the pair's combined margin cancels the color advantage.
    const pairs = new Map();
    for (const g of ratedGames) {
      if (!g.pair) continue;
      if (!pairs.has(g.pair)) pairs.set(g.pair, []);
      pairs.get(g.pair).push(g);
    }
    let pairWins = 0, pairLosses = 0;
    let completePairs = 0;
    for (const pairGames of pairs.values()) {
      if (pairGames.length !== 2 || new Set(pairGames.map(g => g.jevColor)).size !== 2) continue;
      completePairs++;
      const total = pairGames.reduce((sum, g) => sum + g.jevMargin, 0);
      if (total > 0) pairWins++;
      else if (total < 0) pairLosses++;
    }
    output.push({
      opponent, games: ratedGames.length, attemptedGames: games.length, incomplete, wins, draws, losses,
      scoreRate: rate,
      eloDifference: eloDifference(rate),
      approximateElo95: eloBounds,
      signTestP: signTestP(wins, losses),
      pairSignTestP: signTestP(pairWins, pairLosses),
      pairs: completePairs,
      jevBlack: { games: jevBlack.length, wins: blackWins },
      jevWhite: { games: jevWhite.length, wins: whiteWins },
      meanScoreMargin: ratedGames.length
        ? ratedGames.reduce((sum, g) => sum + g.jevMargin, 0) / ratedGames.length
        : null,
      totalApiCalls: games.reduce((sum, g) => sum + g.apiCalls, 0),
      inputTokens: games.reduce((sum, g) => sum + g.inputTokens, 0),
      outputTokens: games.reduce((sum, g) => sum + g.outputTokens, 0),
      models: [...new Set(games.flatMap(g => g.models))],
      opponentModel: [...new Set(games.map(g => g.opponentModel).filter(Boolean))].join(', ') || null,
      warning: decisive === 0 ? 'No decisive games.' : null,
    });
  }
  return output;
}

async function withCanonicalJevState(runtime, state, legal, color, ownLastMove, callback) {
  const engine = runtime.engine;
  const saved = engine.snapshot();
  const canonical = color === engine.BLACK;
  const candidateMoves = canonical
    ? legal.map(move => ({ ...move, board: swapColors(move.board) }))
    : legal;
  const promptState = { ...state, jevLastChoice: ownLastMove || null };
  if (canonical) {
    engine.setState({
      ...promptState,
      board: swapColors(state.board),
      captures: { 1: state.captures[2], 2: state.captures[1] },
      lastMove: state.lastMove ? swapColors(state.lastMove) : null,
      turn: engine.WHITE,
    });
  } else engine.setState(promptState);
  try {
    return await callback(candidateMoves);
  } finally {
    engine.setState(saved);
  }
}

async function retryApiCall(callback) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await callback(); }
    catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function chooseScoringJev(runtime, state, legal, color, ownLastMove) {
  const engine = runtime.engine;
  const selected = await withCanonicalJevState(runtime, state, legal, color, ownLastMove,
    moves => retryApiCall(() => engine.Jev.chooseMove(moves)));
  if (selected === 'pass') return { pass: true };
  const found = legal.find(move => engine.coordName(move.x, move.y) === selected);
  if (!found) throw new Error('Jev returned a non-legal move: ' + selected);
  return { move: found };
}

async function chooseCompactChoiceJev(runtime, state, legal, color, ownLastMove) {
  const engine = runtime.engine;
  const selected = await withCanonicalJevState(runtime, state, legal, color, ownLastMove, async moves => {
    const criteria = Object.fromEntries(moves.map(move => [engine.coordName(move.x, move.y), null]));
    criteria.pass = null;
    const body = {
      model: 'jev-latest',
      state: compactState(engine, engine.snapshot()),
      questions: {
        move: {
          type: 'choice',
          instructions: 'Choose White’s strongest legal point. Save groups in atari, capture opponent groups, build territory, and keep groups connected. Pass only when the position is settled; two consecutive passes end the game.',
          criteria,
        },
      },
    };
    const data = await retryApiCall(async () => {
      const response = await runtime.fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + runtime.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
    runtime.recordApiUsage(data);
    const answer = data.answers && data.answers.move;
    if (!answer || !answer.choice) throw new Error('no Choice answer from compact anchor');
    let choice = answer.choice;
    if (answer.probabilities) {
      const names = new Set([...moves.map(move => engine.coordName(move.x, move.y)), 'pass']);
      const options = Object.entries(answer.probabilities).filter(([name, probability]) => names.has(name) && Number.isFinite(probability));
      if (options.length) choice = options.reduce((best, entry) => entry[1] > best[1] ? entry : best)[0];
    }
    return choice;
  });
  if (selected === 'pass') return { pass: true };
  const found = legal.find(move => engine.coordName(move.x, move.y) === selected);
  if (!found) throw new Error('Choice-only Jev returned a non-legal move: ' + selected);
  return { move: found };
}

async function playGame(runtime, opponent, jevColor, seed, maxTurns, kataGo, traceEntries) {
  const e = runtime.engine;
  if (opponent.kind === 'katago') await kataGo.newGame();
  let state = {
    board: emptyBoard(e.N), captures: { 1: 0, 2: 0 },
    lastMove: null, lastCoord: null, jevLastChoice: null,
    passes: 0, turn: e.BLACK, gameOver: false,
  };
  const colors = { jev: jevColor, opponent: jevColor === e.BLACK ? e.WHITE : e.BLACK };
  const gameId = opponent.id + ':' + seed + ':' + (jevColor === e.BLACK ? 'black' : 'white');
  const randomByPlayer = {
    jev: mulberry32((seed ^ hashText('jev')) >>> 0),
    [opponent.id]: mulberry32((seed ^ hashText(opponent.id)) >>> 0),
  };
  const lastMoveByPlayer = { jev: null, [opponent.id]: null };
  const passCounts = { 1: 0, 2: 0 };
  let turns = 0, finished = false, resignedBy = null, jevDecisionMade = false;
  runtime.resetApiRequests();
  runtime.resetApiUsage();
  e.Jev.clearLog();

  while (turns < maxTurns && state.passes < 2) {
    const color = state.turn;
    const legal = e.legalMoves(state.board, color, state.lastMove);
    let decision;
    const actor = color === jevColor ? { id: 'jev', kind: 'score' } : opponent;
    if (legal.length === 0) {
      decision = { pass: true };
      if (actor.kind === 'katago') await kataGo.play(color, 'pass');
    }
    else if (actor.kind === 'score') {
      runtime.setRandom(randomByPlayer[actor.id]);
      decision = await chooseScoringJev(runtime, state, legal, color, lastMoveByPlayer[actor.id]);
      jevDecisionMade = true;
    } else if (actor.kind === 'choice-only') {
      runtime.setRandom(randomByPlayer[actor.id]);
      decision = await chooseCompactChoiceJev(runtime, state, legal, color, lastMoveByPlayer[actor.id]);
    } else if (actor.kind === 'katago') {
      decision = await kataGo.genmove(color);
      if (!decision.pass && !decision.resign) {
        const matchingMove = legal.find(move => move.x === decision.x && move.y === decision.y);
        if (!matchingMove) throw new Error('KataGo returned an illegal move: ' + e.coordName(decision.x, decision.y));
        decision = { move: matchingMove };
      }
    } else {
      const rng = randomByPlayer[opponent.id];
      runtime.setRandom(rng);
      if (opponent.noise === 1 || (opponent.noise > 0 && rng() < opponent.noise)) decision = randomAnchor(legal, rng);
      else decision = e.heuristicPick(legal, color);
    }
    runtime.clearRandom();
    if (opponent.kind === 'katago' && actor.kind !== 'katago') {
      await kataGo.play(color, decision.pass ? 'pass' : e.coordName(decision.move.x, decision.move.y));
    }
    const entry = {
      type: 'position',
      game: gameId,
      ply: turns + 1,
      color: color === e.BLACK ? 'black' : 'white',
      board: state.board.flat(),
      ko: state.lastMove ? state.lastMove.flat() : null,
      captures: { ...state.captures },
      passes: state.passes,
      legalCount: legal.length,
      move: decision.resign ? 'resign' : decision.pass ? 'pass' : e.coordName(decision.move.x, decision.move.y),
    };
    if (jevDecisionMade) {
      const last = e.Jev.getLog().at(-1);
      if (last && last.ok) {
        entry.jev = {
          choice: last.choice,
          jevChoice: last.jevChoice,
          confidence: last.confidence,
          probabilities: last.probabilities,
          passProbability: last.passProbability,
          passAllowed: last.passAllowed,
          scores: last.scores,
        };
      }
      jevDecisionMade = false;
    }
    traceEntries.push(entry);
    if (decision.resign) { resignedBy = color; break; }
    if (actor.kind === 'score' || actor.kind === 'choice-only') {
      lastMoveByPlayer[actor.id] = decision.pass ? null : e.coordName(decision.move.x, decision.move.y);
    }
    if (decision.pass) {
      passCounts[color]++;
      state.passes++;
      state.lastMove = null;
      state.lastCoord = null;
    } else {
      const move = decision.move;
      state.lastMove = copyBoard(state.board); // position before this move, for the ko check
      state.board = copyBoard(move.board);
      state.captures[color] += move.captured;
      state.lastCoord = { x: move.x, y: move.y };
      state.passes = 0;
    }
    state.turn = color === e.BLACK ? e.WHITE : e.BLACK;
    turns++;
  }
  finished = state.passes >= 2;
  const finalScore = scoreArea(state.board);
  const jevScore = jevColor === e.BLACK ? finalScore.black : finalScore.white;
  const opponentScore = jevColor === e.BLACK ? finalScore.white : finalScore.black;
  const jevWon = resignedBy != null
    ? resignedBy !== jevColor
    : jevScore > opponentScore;
  const draw = resignedBy == null && jevScore === opponentScore;
  const completed = resignedBy != null || finished;
  const result = !completed ? 'incomplete' : draw ? 'draw' : jevWon ? 'win' : 'loss';
  traceEntries.push({
    type: 'terminal',
    game: gameId,
    plies: turns,
    board: state.board.flat(),
    areaOwner: areaOwnerMap(state.board),
    blackScore: finalScore.black,
    whiteScore: finalScore.white,
    jevMargin: jevScore - opponentScore,
    result,
    terminal: resignedBy != null ? 'opponent resigned' : finished ? 'two passes' : 'turn cap',
    resignedBy: resignedBy == null ? null : resignedBy === e.BLACK ? 'black' : 'white',
  });
  const log = e.Jev.getLog();
  const usageEvents = [
    ...log.map(item => ({ model: item.model, usage: item.usage })),
    ...runtime.getApiUsage(),
  ];
  const models = [...new Set(usageEvents.filter(item => item.model).map(item => item.model))];
  const tokens = usageEvents.reduce((totals, item) => {
    const usage = item.usage || {};
    totals.input += Number(usage.input_tokens || usage.prompt_tokens || 0);
    totals.output += Number(usage.output_tokens || usage.completion_tokens || 0);
    return totals;
  }, { input: 0, output: 0 });
  return {
    opponent: opponent.id,
    opponentModel: opponent.kind === 'katago' ? kataGo.metadata.version : null,
    opponentDetails: opponent.kind === 'katago' ? kataGo.metadata : null,
    seed,
    jevColor: jevColor === e.BLACK ? 'black' : 'white',
    result,
    finished,
    turns,
    blackScore: finalScore.black,
    whiteScore: finalScore.white,
    jevScore,
    opponentScore,
    jevMargin: jevScore - opponentScore,
    jevCaptures: state.captures[jevColor],
    opponentCaptures: state.captures[colors.opponent],
    jevPasses: passCounts[jevColor],
    opponentPasses: passCounts[colors.opponent],
    apiCalls: runtime.getApiRequests(),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    models,
    terminal: resignedBy != null ? 'opponent resigned' : finished ? 'two passes' : 'turn cap',
  };
}

function formatElo(value) {
  if (value === Infinity) return '+∞';
  if (value === -Infinity) return '−∞';
  return value == null ? 'unavailable' : (value >= 0 ? '+' : '') + value.toFixed(0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  const apiKey = readApiKey();
  if (!apiKey) throw new Error('Set TYPESAFE_API_KEY or add it to .env before running the Jev benchmark.');
  const runtime = loadGame(apiKey);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.resolve(ROOT, options.output || ('benchmark-results-' + stamp + '.jsonl'));
  const tracePath = outputPath.replace(/\.jsonl$/, '') + '.traces.jsonl';
  fs.writeFileSync(outputPath, '', { flag: 'wx' });
  fs.writeFileSync(tracePath, '', { flag: 'wx' });
  const kataGo = options.opponents.includes('katago-5k') ? await startKataGo(options) : null;
  if (kataGo) console.log('KataGo anchor: ' + kataGo.metadata.version + ', ' + kataGo.metadata.profile + ', ' + kataGo.metadata.rules + ', komi ' + kataGo.metadata.komi);
  const records = [];
  let gameNumber = 0;
  try {
    for (const opponentName of options.opponents) {
      const opponent = makeAnchor(opponentName);
      for (let pair = 0; pair < options.pairs; pair++) {
        const seed = options.seed + pair;
        for (const jevColor of [runtime.engine.BLACK, runtime.engine.WHITE]) {
          const traceEntries = [];
          const record = await playGame(runtime, opponent, jevColor, seed, options.maxTurns, kataGo, traceEntries);
          record.pair = opponent.id + ':' + seed;
          records.push(record);
          fs.appendFileSync(outputPath, JSON.stringify(record) + '\n');
          for (const traceEntry of traceEntries) fs.appendFileSync(tracePath, JSON.stringify(traceEntry) + '\n');
          gameNumber++;
          console.log(
            '[' + gameNumber + '] Jev ' + record.jevColor + ' vs ' + opponent.id + ': ' +
            record.result + ', ' + record.turns + ' plies, margin ' + record.jevMargin.toFixed(1) +
            ', API calls ' + record.apiCalls + (record.finished ? '' : record.terminal === 'opponent resigned' ? ' (resignation)' : ' (turn cap)')
          );
        }
      }
    }
  } finally {
    if (kataGo) await kataGo.close();
  }
  console.log('\nColor-balanced results (Elo difference is per named opponent):');
  for (const row of summarize(records)) {
    const ci = row.approximateElo95.map(formatElo).join(' to ');
    const scoreText = row.scoreRate == null ? 'n/a' : (row.scoreRate * 100).toFixed(1) + '%';
    const marginText = row.meanScoreMargin == null ? 'n/a' : row.meanScoreMargin.toFixed(1);
    console.log(
      row.opponent + ': ' + row.wins + '-' + row.draws + '-' + row.losses +
      ' (Jev W-D-L), score ' + scoreText +
      ', Elo Δ ' + (row.scoreRate === 1 ? '+∞ (all wins)' : row.scoreRate === 0 ? '−∞ (all losses)' : formatElo(row.eloDifference)) +
      ' [' + ci + ' 95% approx]' +
      ', black wins ' + row.jevBlack.wins + '/' + row.jevBlack.games +
      ', white wins ' + row.jevWhite.wins + '/' + row.jevWhite.games +
      ', mean margin ' + marginText +
      ', sign test p ' + (row.signTestP == null ? 'n/a' : row.signTestP.toFixed(3)) +
      ', seed-paired p ' + (row.pairSignTestP == null ? 'n/a' : row.pairSignTestP.toFixed(3)) +
      (row.incomplete ? ', incomplete ' + row.incomplete + '/' + row.attemptedGames + ' (excluded)' : '') +
      ', calls ' + row.totalApiCalls + ', tokens ' + row.inputTokens + '/' + row.outputTokens +
      ', model ' + (row.models.join(', ') || 'unreported') +
      (row.opponentModel ? ', anchor ' + row.opponentModel : '')
    );
  }
  console.log('\nSaved per-game records to ' + path.relative(ROOT, outputPath));
  console.log('Saved position traces and terminal area margins to ' + path.relative(ROOT, tracePath));
  console.log('Elo values are head-to-head differences against each named opponent. local-greedy = 1000 only when that anchor is included.');
}

main().catch(error => { console.error('Benchmark failed: ' + (error.message || String(error))); process.exitCode = 1; });
