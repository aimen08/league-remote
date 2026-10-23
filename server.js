// League Remote — a bridge between the League client (LCU API) on this PC and your phone.
// Run `node server.js` (or LeagueRemote.exe), then scan the QR code with your phone (same Wi-Fi).
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, exec, spawn } = require('child_process');
const QRCode = require('qrcode');
const { createConsoleUI } = require('./console-ui');
const updater = require('./updater');
const { version: VERSION } = require('./package.json');

// When packaged as LeagueRemote.exe the phone app is embedded in the exe.
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }

let port = Number(process.env.PORT) || 3000; // may move to the next free port at startup
// One settings folder for the exe and for `node server.js`, so switching never re-pairs the phone.
const DATA_DIR = process.env.LEAGUE_REMOTE_DATA || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'LeagueRemote')
  : path.join(os.homedir(), '.league-remote'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const INSTANCE_PATH = path.join(DATA_DIR, 'instance.json');
// Versions before 1.2 kept the source version's settings next to server.js: carry them over.
if (!sea && !fs.existsSync(CONFIG_PATH) && fs.existsSync(path.join(__dirname, 'config.json'))) {
  try { fs.copyFileSync(path.join(__dirname, 'config.json'), CONFIG_PATH); } catch {}
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const readPublic = file => sea ? Buffer.from(sea.getAsset(file)) : fs.readFileSync(path.join(PUBLIC_DIR, file));

const ui = createConsoleUI();
function fatal(msg) {
  (ui ? ui.error : console.error)(`\n  ${msg}\n`);
  if (!process.stdin.isTTY) process.exit(1);
  (ui ? ui.error : console.error)('  Press Enter to close.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}
process.on('uncaughtException', e => fatal(`Something went wrong: ${e.message}`));
const LOCKFILE_PATHS = [
  process.env.LEAGUE_DIR && path.join(process.env.LEAGUE_DIR, 'lockfile'),
  'C:\\Riot Games\\League of Legends\\lockfile',
  'D:\\Riot Games\\League of Legends\\lockfile',
  '/Applications/League of Legends.app/Contents/LoL/lockfile',
].filter(Boolean);

// ---------- config (pairing key + toggles), persisted in DATA_DIR ----------
function randomKey() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(6), b => abc[b % abc.length]).join('');
}
const config = (() => {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  cfg.key ??= randomKey();
  cfg.autoAccept ??= false;
  cfg.autoLock ??= true;
  return cfg;
})();
const saveConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
saveConfig();

// ---------- finding the League client ----------
let client = null; // { base, auth }

function credentials(port, password, protocol = 'https') {
  return {
    base: `${protocol}://127.0.0.1:${port}`,
    auth: 'Basic ' + Buffer.from(`riot:${password}`).toString('base64'),
  };
}

function findClient() {
  if (process.env.LCU_URL) {
    return Promise.resolve({ base: process.env.LCU_URL, auth: credentials(0, 'demo').auth });
  }
  const [cmd, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "name='LeagueClientUx.exe'" | Select-Object -ExpandProperty CommandLine`]]
    : ['ps', ['-A', '-o', 'args']];
  return new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (_err, stdout = '') => {
      // The client's command line holds the port and password...
      const port = /--app-port=(\d+)/.exec(stdout);
      const token = /--remoting-auth-token=([^\s"]+)/.exec(stdout);
      if (port && token) return resolve(credentials(port[1], token[1]));
      // ...unless it runs as admin, in which case fall back to the lockfile.
      for (const file of LOCKFILE_PATHS) {
        try {
          const [, , p, pw, proto] = fs.readFileSync(file, 'utf8').trim().split(':');
          if (p && pw) return resolve(credentials(p, pw, proto));
        } catch {}
      }
      resolve(null);
    });
  });
}

// ---------- talking to the client ----------
const lcuAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true }); // the client uses a self-signed cert

function lcu(method, urlPath, body) {
  if (!client) return Promise.reject(Object.assign(new Error('League client is not running'), { status: 503 }));
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, client.base);
    const isHttps = url.protocol === 'https:';
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Authorization: client.auth, Accept: 'application/json' };
    if (data) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    const req = (isHttps ? https : http).request(url, { method, headers, agent: isHttps ? lcuAgent : undefined }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('League client timed out')));
    if (data) req.write(data);
    req.end();
  });
}

async function lcuJson(method, urlPath, body) {
  const res = await lcu(method, urlPath, body);
  const text = res.buf.toString('utf8');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (res.status >= 400) {
    throw Object.assign(new Error(json?.message || `League client said ${res.status}`), { status: res.status });
  }
  return json;
}
const tryJson = (urlPath) => lcuJson('GET', urlPath).catch(() => null);

// ---------- champion select helpers ----------
function summarizeChampSelect(sess) {
  const me = sess.localPlayerCellId;
  const actions = (sess.actions || []).flat();
  const mine = actions.filter(a => a.actorCellId === me && (a.type === 'pick' || a.type === 'ban'));
  const active = mine.find(a => a.isInProgress && !a.completed);
  // When it isn't our turn yet, hovering sets our pick intent.
  const turn = active || mine.find(a => a.type === 'pick' && !a.completed);
  const myPicks = mine.filter(a => a.type === 'pick');
  const bans = new Set([
    ...actions.filter(a => a.type === 'ban' && a.completed && a.championId).map(a => a.championId),
    ...(sess.bans?.myTeamBans || []), ...(sess.bans?.theirTeamBans || []),
  ].filter(id => id > 0));
  const takenByOthers = actions
    .filter(a => a.type === 'pick' && a.completed && a.championId && a.actorCellId !== me)
    .map(a => a.championId);
  const player = p => ({
    cellId: p.cellId,
    championId: p.championId || p.championPickIntent || 0,
    intent: !p.championId && !!p.championPickIntent,
    position: (p.assignedPosition || '').toLowerCase(),
    isMe: p.cellId === me,
  });
  // The client reports time left as of `internalNowInEpochMs` (same PC clock), so turn it into an
  // absolute deadline; otherwise the countdown would run up to a poll interval behind reality.
  const timer = sess.timer || {};
  const readAt = Date.now();
  const asOf = timer.internalNowInEpochMs && Math.abs(timer.internalNowInEpochMs - readAt) < 10000 ? timer.internalNowInEpochMs : readAt;
  return {
    timerPhase: timer.phase || '',
    deadline: asOf + Math.max(0, timer.adjustedTimeLeftInPhase ?? 0),
    turn: turn ? { id: turn.id, type: turn.type, active: turn === active, championId: turn.championId || 0 } : null,
    locked: myPicks.length > 0 && myPicks.every(a => a.completed),
    myTeam: (sess.myTeam || []).map(player),
    theirTeam: (sess.theirTeam || []).map(player),
    bans: [...bans],
    unavailable: [...new Set([...bans, ...takenByOthers])],
  };
}

async function readSession() {
  const sess = await lcuJson('GET', '/lol-champ-select/v1/session');
  return { sess, actions: (sess.actions || []).flat(), turn: summarizeChampSelect(sess).turn };
}

// The phone says which turn it was looking at; refuse if the client has moved on since,
// so a tap meant for a ban never lands on a pick (or the other way round).
async function turnFor(actionId) {
  const { actions, turn } = await readSession();
  if (!turn) throw Object.assign(new Error('Nothing to pick or ban right now'), { status: 409 });
  if (actionId && turn.id !== actionId) {
    const old = actions.find(a => a.id === actionId);
    if (old?.completed) return { turn, alreadyDone: old };
    throw Object.assign(new Error('Your turn changed — check the screen and try again'), { status: 409 });
  }
  return { turn };
}

// Which champions the client allows for this pick/ban. Returns null when the client won't say,
// so the phone leaves everything tappable instead of greying it all out.
const listSources = {};
async function availableFor(type) {
  const paths = type === 'ban'
    ? ['/lol-champ-select/v1/bannable-champion-ids', '/lol-lobby-team-builder/champ-select/v1/bannable-champion-ids']
    : ['/lol-champ-select/v1/pickable-champion-ids', '/lol-lobby-team-builder/champ-select/v1/pickable-champion-ids'];
  let list = null, source = 'none (everything tappable)';
  for (const p of paths) {
    const r = await tryJson(p);
    if (Array.isArray(r) && r.length) { list = r.map(Number); source = p; break; }
  }
  if (!list && type === 'pick') {
    const owned = await tryJson('/lol-champions/v1/owned-champions-minimal');
    if (Array.isArray(owned) && owned.length) {
      list = owned.filter(c => c.ownership?.owned || c.ownership?.rental?.rented || c.freeToPlay).map(c => c.id);
      source = 'owned champions';
    }
  }
  if (listSources[type] !== source) {
    listSources[type] = source;
    if (!ui) console.log(`${type} list from: ${source}`);
  }
  return list;
}

// Keep the last failure on disk so problems in real games can be diagnosed afterwards.
async function logFailure(step, err) {
  if (!ui) console.log(`${step} failed: ${err.status || ''} ${err.message}`);
  const session = await tryJson('/lol-champ-select/v1/session');
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'debug-last-error.json'),
      JSON.stringify({ time: new Date().toISOString(), step, status: err.status, message: err.message, session }, null, 2));
  } catch {}
}

async function hover(championId, actionId) {
  const { turn, alreadyDone } = await turnFor(actionId);
  if (alreadyDone) throw Object.assign(new Error('Already locked — hover not changed'), { status: 409 });
  try {
    await lcuJson('PATCH', `/lol-champ-select/v1/session/actions/${turn.id}`, { championId });
  } catch (e) {
    await logFailure(`hover ${turn.type} ${championId}`, e);
    throw e;
  }
  // Only report success once the client shows the hover (on the action, or as our pick intent).
  for (let i = 0; i < 4; i++) {
    const { sess, actions } = await readSession();
    const me = (sess.myTeam || []).find(p => p.cellId === sess.localPlayerCellId);
    if (actions.find(a => a.id === turn.id)?.championId === championId ||
        (turn.type === 'pick' && (me?.championPickIntent === championId || me?.championId === championId))) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw Object.assign(new Error('The client did not take the hover — try again'), { status: 502 });
}

async function actionState(id) {
  await new Promise(r => setTimeout(r, 250));
  const sess = await tryJson('/lol-champ-select/v1/session');
  return (sess?.actions || []).flat().find(a => a.id === id);
}

// One lock at a time, so a manual lock and the auto-lock never race each other.
let lockQueue = Promise.resolve();
function lockIn(championId, actionId) {
  const run = lockQueue.then(() => doLockIn(championId, actionId));
  lockQueue = run.catch(() => {});
  return run;
}

async function doLockIn(championId, actionId) {
  const { turn, alreadyDone } = await turnFor(actionId);
  if (alreadyDone) return { championId: alreadyDone.championId, type: alreadyDone.type };
  if (!turn.active) throw Object.assign(new Error("It's not your turn yet"), { status: 409 });
  championId ||= turn.championId;
  if (!championId) throw Object.assign(new Error('Pick a champion first'), { status: 400 });
  const url = `/lol-champ-select/v1/session/actions/${turn.id}`;
  // Clients differ in which of these they accept, so try each and check the result.
  const attempts = [
    ['PATCH with completed', () => lcuJson('PATCH', url, { championId, completed: true })],
    ['PATCH then complete', async () => { await lcuJson('PATCH', url, { championId }); await lcuJson('POST', `${url}/complete`); }],
    ['PATCH full action', () => lcuJson('PATCH', url, { championId, completed: true, id: turn.id, isAllyAction: true, type: turn.type })],
  ];
  let lastError = null;
  for (const [name, run] of attempts) {
    try { await run(); } catch (e) { lastError = e; await logFailure(`lock ${turn.type} (${name})`, e); }
    const after = await actionState(turn.id);
    if (after?.completed) return { championId: after.championId, type: turn.type };
  }
  throw Object.assign(new Error(lastError ? `NOT locked — client said: ${lastError.message}` : 'NOT locked — the client did not accept it'), { status: 502 });
}

// ---------- state loop ----------
// Auto-lock starts this long before the timer ends: the state loop runs every 0.5 s in champ
// select and a lock (with retries and checks) takes at most ~1.5 s, so it always finishes in time.
const AUTO_LOCK_MS = 4000;
let state = { connected: false };
let stateAt = Date.now();
let refreshSeq = 0, appliedSeq = 0;
// Refreshes can overlap (the loop plus one after each phone action); never let an older one
// overwrite newer data.
const applyState = (s, seq) => { if (seq < appliedSeq) return; appliedSeq = seq; state = s; stateAt = Date.now(); };
let summoner = null;
let champions = null;
let iconCache = new Map();
let lastAutoLockedAction = null;
let clientAnswered = false;

async function refresh() {
  const seq = ++refreshSeq;
  const setState = s => applyState(s, seq);
  if (!client) {
    client = await findClient();
    if (!client) { setState({ connected: false }); return; }
    summoner = null; champions = null; iconCache = new Map();
  }

  let phase;
  try {
    phase = await lcuJson('GET', '/lol-gameflow/v1/gameflow-phase');
  } catch (e) {
    // No answer, or the wrong password (a stale lockfile): we are not connected.
    if (!e.status || e.status === 401 || e.status === 403) {
      if (clientAnswered) console.log('League client closed.');
      clientAnswered = false;
      client = null;
      setState({ connected: false });
    } else {
      setState({ connected: true, phase: 'Loading' }); // answering, but still starting up
    }
    return;
  }
  // Only claim a connection once the client has actually answered.
  if (!clientAnswered) { clientAnswered = true; console.log('Connected to the League client.'); }

  if (!summoner) {
    const s = await tryJson('/lol-summoner/v1/current-summoner');
    summoner = s && (s.gameName ? `${s.gameName}#${s.tagLine}` : s.displayName) || null;
  }

  const next = { connected: true, phase, summoner, autoAccept: config.autoAccept, autoLock: config.autoLock };

  if (phase === 'Lobby') {
    const lobby = await tryJson('/lol-lobby/v2/lobby');
    next.lobby = lobby && {
      queueId: lobby.gameConfig?.queueId,
      canStart: !!lobby.canStartActivity,
      isLeader: !!lobby.localMember?.isLeader,
      members: lobby.members?.length || 1,
      showRoles: !!lobby.gameConfig?.showPositionSelector,
      firstRole: lobby.localMember?.firstPositionPreference || 'UNSELECTED',
      secondRole: lobby.localMember?.secondPositionPreference || 'UNSELECTED',
    };
  } else if (phase === 'Matchmaking') {
    const s = await tryJson('/lol-matchmaking/v1/search');
    next.search = s && { timeInQueue: s.timeInQueue || 0, estimated: s.estimatedQueueTime || 0 };
  } else if (phase === 'ReadyCheck') {
    const rc = await tryJson('/lol-matchmaking/v1/ready-check');
    next.readyCheck = rc && { response: rc.playerResponse, timer: rc.timer || 0 };
    if (config.autoAccept && rc?.state === 'InProgress' && rc.playerResponse === 'None') {
      try {
        await lcuJson('POST', '/lol-matchmaking/v1/ready-check/accept');
        console.log('Auto-accepted the match.');
      } catch (e) {
        console.log(`Auto-accept failed: ${e.message}`);
      }
    }
  } else if (phase === 'ChampSelect') {
    const sess = await tryJson('/lol-champ-select/v1/session');
    if (sess) {
      const cs = summarizeChampSelect(sess);
      if (cs.turn) cs.available = await availableFor(cs.turn.type);
      // Lock the hovered champion just before the timer runs out (a missed pick dodges the game).
      const t = cs.turn;
      if (config.autoLock && t?.active && t.championId && cs.deadline - Date.now() < AUTO_LOCK_MS && lastAutoLockedAction !== t.id) {
        lastAutoLockedAction = t.id;
        await lockIn(t.championId, t.id)
          .then(() => console.log(`Auto-locked your ${t.type} before the timer ran out.`))
          .catch(e => console.log(`Auto-lock FAILED: ${e.message}`));
      }
      next.champSelect = cs;
    }
  }

  setState(next);
}

(async function loop() {
  try { await refresh(); } catch (e) { console.log(`Refresh failed: ${e.message}`); }
  const fast = state.phase === 'ChampSelect' || state.phase === 'ReadyCheck';
  setTimeout(loop, !client ? 3000 : fast ? 500 : 1000);
})();

async function getChampions() {
  if (!champions) {
    const list = await lcuJson('GET', '/lol-game-data/assets/v1/champion-summary.json');
    champions = list
      .filter(c => c.id > 0)
      .map(c => ({ id: c.id, name: c.name, alias: c.alias }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return champions;
}

// ---------- phone-facing HTTP server ----------
const QUEUES = new Set([400, 420, 440, 450, 480, 490]);
const ROLES = new Set(['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'FILL', 'UNSELECTED']);

const api = {
  'GET /api/state': () => {
    const now = Date.now();
    const s = { ...state, version: VERSION, stateAgeMs: now - stateAt, serverTime: now };
    if (s.champSelect) s.champSelect = { ...s.champSelect, timeLeftMs: Math.max(0, s.champSelect.deadline - now) };
    return s;
  },
  'GET /api/champions': () => getChampions(),
  'POST /api/accept': () => lcuJson('POST', '/lol-matchmaking/v1/ready-check/accept'),
  'POST /api/decline': () => lcuJson('POST', '/lol-matchmaking/v1/ready-check/decline'),
  'POST /api/lobby': ({ queueId }) => {
    if (!QUEUES.has(queueId)) throw Object.assign(new Error('Unknown queue'), { status: 400 });
    return lcuJson('POST', '/lol-lobby/v2/lobby', { queueId });
  },
  'POST /api/roles': ({ first, second }) => {
    if (!ROLES.has(first) || !ROLES.has(second)) throw Object.assign(new Error('Unknown role'), { status: 400 });
    return lcuJson('PUT', '/lol-lobby/v2/lobby/members/localMember/position-preferences',
      { firstPreference: first, secondPreference: second });
  },
  'POST /api/queue/start': () => lcuJson('POST', '/lol-lobby/v2/lobby/matchmaking/search'),
  'POST /api/queue/stop': () => lcuJson('DELETE', '/lol-lobby/v2/lobby/matchmaking/search'),
  'POST /api/play-again': () => lcuJson('POST', '/lol-lobby/v2/play-again'),
  'POST /api/hover': ({ championId, actionId }) => hover(Number(championId), Number(actionId) || 0),
  'POST /api/lock': ({ championId, actionId }) => lockIn(Number(championId) || 0, Number(actionId) || 0),
  'POST /api/settings': (body) => {
    for (const k of ['autoAccept', 'autoLock']) if (typeof body[k] === 'boolean') config[k] = body[k];
    saveConfig();
    state = { ...state, autoAccept: config.autoAccept, autoLock: config.autoLock };
    return { autoAccept: config.autoAccept, autoLock: config.autoLock };
  },
};

const ACTION_NAMES = {
  '/api/accept': 'accept', '/api/decline': 'decline', '/api/lobby': 'open lobby', '/api/roles': 'set roles',
  '/api/queue/start': 'find match', '/api/queue/stop': 'leave queue', '/api/play-again': 'play again',
  '/api/hover': 'hover', '/api/lock': 'lock in', '/api/settings': 'settings',
};

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

function send(res, status, body, type = 'application/json') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(type === 'application/json' ? JSON.stringify(body) : body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

function keyOk(req) {
  const given = Buffer.from(String(req.headers['x-key'] || ''));
  const want = Buffer.from(config.key);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map(i => i.address)
    .sort((a, b) => Number(!/^(192\.168|10\.|172\.)/.test(a)) - Number(!/^(192\.168|10\.|172\.)/.test(b)))
    .map(ip => `http://${ip}:${port}/#k=${config.key}`);
}

// The last phone that polled, for the status shown in the console window.
let phone = { ip: null, lastSeen: 0 };

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (STATIC[pathname] && req.method === 'GET') {
      const [file, type] = STATIC[pathname];
      return send(res, 200, readPublic(file), type);
    }

    // Pairing page with a QR code — only shown on this PC.
    if (pathname === '/pair' && req.method === 'GET') {
      if (!isLocal(req)) return send(res, 403, 'Open this page on the PC running League Remote.', 'text/plain');
      const codes = await Promise.all(lanUrls().map(async url => ({
        url, svg: await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'L' }),
      })));
      const page = readPublic('pair.html').toString('utf8')
        .replace('__CODES__', JSON.stringify(codes).replace(/</g, '\\u003c'));
      return send(res, 200, page, 'text/html; charset=utf-8');
    }

    // Champion icons, proxied from the client (no key needed — <img> can't send headers).
    const icon = /^\/icon\/(\d+)$/.exec(pathname);
    if (icon && req.method === 'GET') {
      let buf = iconCache.get(icon[1]);
      if (!buf) {
        const r = await lcu('GET', `/lol-game-data/assets/v1/champion-icons/${icon[1]}.png`);
        if (r.status !== 200) return send(res, 404, { error: 'no icon' });
        buf = r.buf;
        iconCache.set(icon[1], buf);
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
      return res.end(buf);
    }

    const handler = api[`${req.method} ${pathname}`];
    if (!handler) return send(res, 404, { error: 'Not found' });
    if (!keyOk(req)) return send(res, 401, { error: 'Wrong or missing pairing code' });
    if (!isLocal(req)) phone = { ip: req.socket.remoteAddress.replace('::ffff:', ''), lastSeen: Date.now() };
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await handler(body);
    if (req.method === 'POST' && !['/api/hover', '/api/settings', '/api/roles'].includes(pathname)) {
      const champ = result?.championId && (await getChampions().catch(() => [])).find(c => c.id === result.championId)?.name;
      console.log(`Phone: ${result?.type === 'ban' ? 'ban' : ACTION_NAMES[pathname]}${champ ? ` ${champ}` : ''} ✓`);
    }
    if (req.method === 'POST') await refresh().catch(() => {}); // so the phone's next poll sees the result
    return send(res, 200, result ?? { ok: true });
  } catch (e) {
    if (pathname.startsWith('/api/') && req.method === 'POST') console.log(`Phone: ${ACTION_NAMES[pathname] || pathname} failed — ${e.message}`);
    return send(res, e.status && e.status < 600 ? e.status : 500, { error: e.message });
  }
});

// ---------- starting up ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function listenOn(p) {
  return new Promise((resolve, reject) => {
    const onError = e => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, '0.0.0.0');
  });
}

// Is the program on this port another League Remote (any version)? Every version serves this title.
function isLeagueRemoteOn(p) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/', timeout: 1500 }, res => {
      let body = '';
      res.on('data', c => { if (body.length < 4000) body += c; });
      res.on('end', () => resolve(body.includes('<title>League Remote</title>')));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

// The process listening on a port, as { pid, name }. Matches netstat's address columns
// (a listening socket's remote address is 0.0.0.0:0 or [::]:0), not its translated state word.
function portOwner(p) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('netstat', ['-ano'], { windowsHide: true, timeout: 5000 }, (_e, out = '') => {
      const re = new RegExp(`^\\s*TCP\\s+\\S+:${p}\\s+(?:0\\.0\\.0\\.0:0|\\[::\\]:0)\\s+\\S+\\s+(\\d+)\\s*$`, 'i');
      const pid = Number(out.split(/\r?\n/).map(l => re.exec(l)?.[1]).find(Boolean));
      if (!pid) return resolve(null);
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (_e2, o2 = '') => {
        resolve({ pid, name: /^"([^"]+)"/.exec(o2.trim())?.[1] || 'another app' });
      });
    });
  });
}

async function start() {
  const wanted = port;
  // The window recorded as running (possibly on another port, or an older version after an update).
  await closeRecordedInstance();
  try { return await listenOn(port); } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }

  if (await isLeagueRemoteOn(port)) {
    // An older League Remote window: close it and take its place, so a paired phone keeps working.
    const owner = await portOwner(port);
    if (owner && owner.pid !== process.pid) {
      try { process.kill(owner.pid); } catch {}
      for (let i = 0; i < 20; i++) {
        await sleep(250);
        try {
          await listenOn(port);
          console.log('Closed the other League Remote window and took over.');
          return;
        } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
      }
    }
    console.log(`Another League Remote on port ${port} could not be closed (running as admin?).`);
  } else {
    const owner = await portOwner(port);
    console.log(`Port ${port} is used by ${owner?.name || 'another app'} — left it alone.`);
  }

  // Never close someone else's program: move to the next free port instead.
  for (let p = wanted + 1; p <= wanted + 20; p++) {
    try {
      await listenOn(p);
      port = p;
      console.log(`Using port ${p} instead — scan the new QR code on your phone.`);
      return;
    } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error(`Ports ${wanted}–${wanted + 20} are all in use.`);
}

// Closes the League Remote recorded in instance.json, after checking that the recorded process
// really is League Remote (Windows reuses process ids).
async function closeRecordedInstance() {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(INSTANCE_PATH, 'utf8')); } catch { return; }
  if (!rec?.pid || rec.pid === process.pid) return;
  try { process.kill(rec.pid, 0); } catch { return; } // not running any more
  if (!(await isLeagueRemoteOn(rec.port))) return;
  if ((await portOwner(rec.port))?.pid !== rec.pid) return;
  try { process.kill(rec.pid); } catch { return; }
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { process.kill(rec.pid, 0); } catch {
      console.log(rec.version && rec.version !== VERSION
        ? `Closed League Remote ${rec.version} and took over.`
        : 'Closed the other League Remote window and took over.');
      return;
    }
  }
}

function recordInstance() {
  try { fs.writeFileSync(INSTANCE_PATH, JSON.stringify({ pid: process.pid, port, version: VERSION })); } catch {}
  process.on('exit', () => {
    try { if (JSON.parse(fs.readFileSync(INSTANCE_PATH, 'utf8')).pid === process.pid) fs.rmSync(INSTANCE_PATH); } catch {}
  });
}

// ---------- self-update (the exe only) ----------
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
// Restarting takes a few seconds, so never do it while a queue pop or champ select could be missed.
const SAFE_TO_RESTART = new Set(['None', 'Lobby', 'GameStart', 'InProgress', 'Reconnect', 'PreEndOfGame', 'WaitingForStats', 'EndOfGame']);
let update = { status: process.env.LEAGUE_REMOTE_NO_UPDATE ? 'off' : 'checking' };
let updateBusy = false;

async function checkForUpdates() {
  if (updateBusy || update.status === 'off' || update.status === 'ready' || update.status === 'installing') return;
  updateBusy = true;
  try {
    const info = await updater.checkForUpdate(VERSION);
    if (!info) { update = { status: 'latest' }; return; }
    if (!sea) {
      if (update.version !== info.version) console.log(`Version ${info.version} is available — download it from GitHub.`);
      update = { status: 'available', version: info.version };
      return;
    }
    update = { status: 'downloading', version: info.version };
    console.log(`Downloading update ${info.version}…`);
    const staged = await updater.downloadUpdate(info, process.execPath);
    update = { status: 'ready', version: info.version, staged };
    console.log(`Update ${info.version} downloaded and verified.`);
    installWhenSafe();
  } catch (e) {
    update = { status: 'failed' };
    console.log(`Update check failed: ${e.message}`);
  } finally {
    updateBusy = false;
  }
}

function installWhenSafe() {
  let told = false;
  const timer = setInterval(() => {
    if (state.connected && !SAFE_TO_RESTART.has(state.phase)) {
      if (!told) { told = true; console.log('Update will install after this queue / champ select.'); }
      return;
    }
    clearInterval(timer);
    installUpdate();
  }, 2000);
}

function installUpdate() {
  const exe = process.execPath;
  try {
    updater.applyUpdate(update.staged, exe);
  } catch (e) {
    update = { status: 'failed' };
    return console.log(`Update could not be installed (${e.message}) — keeping ${VERSION}.`);
  }
  update = { ...update, status: 'installing' };
  console.log(`Starting League Remote ${update.version}…`);
  // The new version takes over from this one (see closeRecordedInstance). This one keeps
  // serving until then, and puts the old exe back if the new one never shows up.
  spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${exe}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const target = update.version;
  setTimeout(() => {
    try {
      fs.renameSync(exe, exe + '.failed');
      fs.renameSync(exe + '.old', exe);
      fs.rmSync(exe + '.failed', { force: true });
    } catch {}
    update = { status: 'failed' };
    console.log(`Update ${target} did not start — still running ${VERSION}.`);
  }, 60000).unref();
}

start().then(onListening).catch(e => fatal(e.message));

function onListening() {
  recordInstance();
  if (sea) updater.cleanupOld(process.execPath);
  setTimeout(checkForUpdates, 5000);
  setInterval(checkForUpdates, UPDATE_EVERY_MS).unref();
  if (ui) {
    const tick = () => ui.update({
      urls: lanUrls(),
      key: config.key,
      version: VERSION,
      update,
      league: { connected: !!state.connected, phase: state.phase, summoner: state.summoner },
      phone: { connected: Date.now() - phone.lastSeen < 6000, ever: !!phone.ip, ip: phone.ip },
      settings: { autoAccept: config.autoAccept, autoLock: config.autoLock },
    });
    tick();
    setInterval(tick, 500);
  } else {
    console.log('\n  League Remote is running.\n');
    console.log('  On your phone (same Wi-Fi), open:');
    for (const u of lanUrls()) console.log(`    ${u}`);
    console.log(`\n  Pairing code: ${config.key}`);
    console.log(`  QR code to scan: http://localhost:${port}/pair\n`);
  }
  if (process.argv.includes('--open')) {
    const url = `http://localhost:${port}/pair`;
    exec(process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`);
  }
}
