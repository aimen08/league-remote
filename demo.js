// Demo mode: a fake League client so you can try the phone app without League running.
// `node demo.js` starts the fake client and League Remote together.
'use strict';
const http = require('http');
const https = require('https');

const MOCK_PORT = 5999;
const CHAMPS = [
  [1, 'Annie'], [22, 'Ashe'], [12, 'Alistar'], [84, 'Akali'], [103, 'Ahri'], [32, 'Amumu'], [53, 'Blitzcrank'],
  [63, 'Brand'], [51, 'Caitlyn'], [69, 'Cassiopeia'], [36, 'DrMundo', 'Dr. Mundo'], [119, 'Draven'], [81, 'Ezreal'],
  [114, 'Fiora'], [86, 'Garen'], [104, 'Graves'], [39, 'Irelia'], [202, 'Jhin'], [222, 'Jinx'], [145, 'Kaisa', "Kai'Sa"],
  [99, 'Lux'], [11, 'MasterYi', 'Master Yi'], [21, 'MissFortune', 'Miss Fortune'], [25, 'Morgana'], [111, 'Nautilus'],
  [76, 'Nidalee'], [555, 'Pyke'], [92, 'Riven'], [235, 'Senna'], [17, 'Teemo'], [412, 'Thresh'], [4, 'TwistedFate', 'Twisted Fate'],
  [67, 'Vayne'], [254, 'Vi'], [157, 'Yasuo'], [777, 'Yone'], [238, 'Zed'], [115, 'Ziggs'],
].map(([id, alias, name]) => ({ id, alias, name: name || alias, squarePortraitPath: '' }));

const ME = 2;
let phase = 'None', lobbyQueue = null, searchStart = 0, rc = null, cs = null, gameEnd = 0;
let roles = { first: 'UNSELECTED', second: 'UNSELECTED' };
const ROLE_QUEUES = new Set([400, 420, 440]);
const rolesReady = () => !ROLE_QUEUES.has(lobbyQueue) || roles.first === 'FILL' || (roles.first !== 'UNSELECTED' && roles.second !== 'UNSELECTED');

function newChampSelect() {
  const now = Date.now();
  const myTeam = [0, 1, 2, 3, 4].map(c => ({ cellId: c, championId: 0, championPickIntent: 0, assignedPosition: ['top', 'jungle', 'middle', 'bottom', 'utility'][c] }));
  const theirTeam = [5, 6, 7, 8, 9].map(c => ({ cellId: c, championId: 0, championPickIntent: 0, assignedPosition: '' }));
  cs = {
    localPlayerCellId: ME, myTeam, theirTeam, bans: { myTeamBans: [], theirTeamBans: [] },
    steps: [
      { name: 'PLANNING', ms: 10000 },
      { name: 'BAN', ms: 30000, mine: { id: 1, type: 'ban' } },
      { name: 'OTHERS', ms: 4000 },
      { name: 'PICK', ms: 30000, mine: { id: 2, type: 'pick' } },
      { name: 'FINALIZATION', ms: 10000 },
    ],
    step: 0, stepStart: now,
    myBan: { id: 1, actorCellId: ME, type: 'ban', championId: 0, completed: false, isInProgress: false },
    myPick: { id: 2, actorCellId: ME, type: 'pick', championId: 0, completed: false, isInProgress: false },
    otherPicks: [],
  };
}

function advance() {
  const now = Date.now();
  if (phase === 'Matchmaking' && now - searchStart > 5000) { phase = 'ReadyCheck'; rc = { start: now, response: 'None' }; }
  if (phase === 'ReadyCheck') {
    if (rc.response === 'Accepted' && now - rc.acceptedAt > 1500) { phase = 'ChampSelect'; newChampSelect(); }
    else if (rc.response === 'Declined' || now - rc.start > 12000) { phase = 'Lobby'; }
  }
  if (phase === 'ChampSelect') {
    let st = cs.steps[cs.step];
    const action = st.mine && (st.mine.type === 'ban' ? cs.myBan : cs.myPick);
    if (action?.completed || now - cs.stepStart > st.ms) {
      if (action && !action.completed) { phase = 'Lobby'; console.log('[demo] timer ran out — dodged'); return; }
      if (st.name === 'FINALIZATION') { phase = 'InProgress'; gameEnd = now + 15000; return; }
      if (st.name === 'BAN') { cs.bans.theirTeamBans = [157, 238]; cs.bans.myTeamBans = [cs.myBan.championId, 555].filter(Boolean); }
      if (st.name === 'OTHERS') {
        const picks = [[0, 86], [1, 254], [5, 92], [6, 104]];
        for (const [cell, champ] of picks) {
          (cell < 5 ? cs.myTeam[cell] : cs.theirTeam[cell - 5]).championId = champ;
          cs.otherPicks.push({ id: 10 + cell, actorCellId: cell, type: 'pick', championId: champ, completed: true, isInProgress: false });
        }
      }
      cs.step++; cs.stepStart = now; st = cs.steps[cs.step];
    }
    cs.myBan.isInProgress = st.name === 'BAN' && !cs.myBan.completed;
    cs.myPick.isInProgress = st.name === 'PICK' && !cs.myPick.completed;
    const me = cs.myTeam[ME];
    me.championPickIntent = cs.myPick.championId;
    if (cs.myPick.completed) me.championId = cs.myPick.championId;
  }
  if (phase === 'InProgress' && now > gameEnd) phase = 'EndOfGame';
}

function sessionJson() {
  const st = cs.steps[cs.step];
  const timerPhase = st.name === 'PLANNING' ? 'PLANNING' : st.name === 'FINALIZATION' ? 'FINALIZATION' : 'BAN_PICK';
  return {
    localPlayerCellId: ME, myTeam: cs.myTeam, theirTeam: cs.theirTeam, bans: cs.bans,
    actions: [[cs.myBan], cs.otherPicks, [cs.myPick]],
    timer: { phase: timerPhase, adjustedTimeLeftInPhase: Math.max(0, st.ms - (Date.now() - cs.stepStart)), internalNowInEpochMs: Date.now() },
  };
}

function taken() {
  return new Set([...cs.bans.myTeamBans, ...cs.bans.theirTeamBans, ...cs.myTeam.map(p => p.championId), ...cs.theirTeam.map(p => p.championId)]);
}

function icon(id, res) {
  const url = `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${id}.png`;
  https.get(url, r => {
    if (r.statusCode !== 200) { res.writeHead(404); r.resume(); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png' }); r.pipe(res);
  }).on('error', () => { res.writeHead(404); res.end(); });
}

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    advance();
    const body = raw ? JSON.parse(raw) : {};
    const p = new URL(req.url, 'http://x').pathname, m = req.method;
    const route = `${m} ${p}`;
    let match;

    if (route === 'GET /lol-gameflow/v1/gameflow-phase') return json(res, 200, phase);
    if (route === 'GET /lol-summoner/v1/current-summoner') return json(res, 200, { gameName: 'Toilet Gamer', tagLine: 'DEMO' });
    if (route === 'GET /lol-game-data/assets/v1/champion-summary.json') return json(res, 200, [{ id: -1, name: 'None', alias: 'None' }, ...CHAMPS]);
    // You "own" every champion except Yone and Zed.
    if (route === 'GET /lol-champions/v1/owned-champions-minimal') return json(res, 200, CHAMPS.map(c => ({ id: c.id, freeToPlay: false, ownership: { owned: c.id !== 777 && c.id !== 238 } })));
    if ((match = /^\/lol-game-data\/assets\/v1\/champion-icons\/(\d+)\.png$/.exec(p))) return icon(match[1], res);

    if (route === 'POST /lol-lobby/v2/lobby') { phase = 'Lobby'; lobbyQueue = body.queueId; return json(res, 200, {}); }
    if (route === 'GET /lol-lobby/v2/lobby') return phase === 'Lobby' ? json(res, 200, {
      canStartActivity: rolesReady(),
      localMember: { isLeader: true, firstPositionPreference: roles.first, secondPositionPreference: roles.second },
      gameConfig: { queueId: lobbyQueue, showPositionSelector: ROLE_QUEUES.has(lobbyQueue) }, members: [{}],
    }) : json(res, 404, { message: 'LOBBY_NOT_FOUND' });
    if (route === 'PUT /lol-lobby/v2/lobby/members/localMember/position-preferences') { roles = { first: body.firstPreference, second: body.secondPreference }; return json(res, 201); }
    if (route === 'POST /lol-lobby/v2/lobby/matchmaking/search') {
      if (phase !== 'Lobby') return json(res, 400, { message: 'Not in a lobby' });
      if (!rolesReady()) return json(res, 400, { message: 'INVALID_POSITION_PREFERENCES' });
      phase = 'Matchmaking'; searchStart = Date.now(); return json(res, 204);
    }
    if (route === 'DELETE /lol-lobby/v2/lobby/matchmaking/search') { phase = 'Lobby'; return json(res, 204); }
    if (route === 'POST /lol-lobby/v2/play-again') { phase = 'Lobby'; return json(res, 204); }
    if (route === 'GET /lol-matchmaking/v1/search') return json(res, 200, { timeInQueue: (Date.now() - searchStart) / 1000, estimatedQueueTime: 95 });

    if (route === 'GET /lol-matchmaking/v1/ready-check') return phase === 'ReadyCheck' ? json(res, 200, { state: 'InProgress', playerResponse: rc.response, timer: (Date.now() - rc.start) / 1000 }) : json(res, 404, { message: 'No ready check' });
    if (route === 'POST /lol-matchmaking/v1/ready-check/accept') { if (phase !== 'ReadyCheck') return json(res, 500, { message: 'No ready check' }); rc.response = 'Accepted'; rc.acceptedAt = Date.now(); return json(res, 204); }
    if (route === 'POST /lol-matchmaking/v1/ready-check/decline') { if (rc) rc.response = 'Declined'; return json(res, 204); }

    if (phase === 'ChampSelect') {
      if (route === 'GET /lol-champ-select/v1/session') return json(res, 200, sessionJson());
      // Like the real client in the user's game: these lists come back empty or missing.
      if (route === 'GET /lol-champ-select/v1/pickable-champion-ids') return json(res, 200, []);
      if (route === 'GET /lol-champ-select/v1/bannable-champion-ids') return json(res, 404, { message: 'Not found' });
      if ((match = /^\/lol-champ-select\/v1\/session\/actions\/(\d+)(\/complete)?$/.exec(p))) {
        const a = [cs.myBan, cs.myPick].find(x => x.id === Number(match[1]));
        if (!a) return json(res, 404, { message: 'No such action' });
        if (m === 'PATCH') {
          if (body.championId && taken().has(body.championId)) return json(res, 500, { message: 'Champion is not available' });
          if (body.championId) a.championId = body.championId;
          // `completed` in a PATCH is ignored here, so the server must fall back to /complete.
          return json(res, 204);
        }
        if (m === 'POST' && match[2]) {
          if (!a.isInProgress) return json(res, 500, { message: 'Action is not in progress' });
          if (!a.championId) return json(res, 500, { message: 'No champion selected' });
          a.completed = true; return json(res, 204);
        }
      }
    }
    json(res, 404, { message: `Mock has no ${route}` });
  });
}).listen(MOCK_PORT, '127.0.0.1', () => {
  console.log(`[demo] Fake League client running on port ${MOCK_PORT}`);
  if (process.argv.includes('--mock-only')) return; // e.g. to test the built exe with LCU_URL
  process.env.LCU_URL = `http://127.0.0.1:${MOCK_PORT}`;
  require('./server');
});
