// Demo mode: a fake League client so you can try the phone app without League running.
// `node demo.js` starts the fake client and League Remote together.
'use strict';
const http = require('http');
const https = require('https');

const MOCK_PORT = 5999;
// The full roster as of patch 16.21 (2026-10-23), saved from Community Dragon so demo mode works offline.
const CHAMPS = require('./demo-champions.json').champions.map(c => ({ ...c, squarePortraitPath: '' }));

// Runes and summoner spells (real ids; icon paths in the client's own format).
const P = (id, name, path) => ({ id, name, iconPath: `/lol-game-data/assets/v1/perk-images/${path}` });
const PERKS = [
  P(8005, 'Press the Attack', 'Styles/Precision/PressTheAttack/PressTheAttack.png'),
  P(8008, 'Lethal Tempo', 'Styles/Precision/LethalTempo/LethalTempoTemp.png'),
  P(8021, 'Fleet Footwork', 'Styles/Precision/FleetFootwork/FleetFootwork.png'),
  P(8010, 'Conqueror', 'Styles/Precision/Conqueror/Conqueror.png'),
  P(9111, 'Triumph', 'Styles/Precision/Triumph.png'),
  P(9104, 'Legend: Alacrity', 'Styles/Precision/LegendAlacrity/LegendAlacrity.png'),
  P(8014, 'Coup de Grace', 'Styles/Precision/CoupDeGrace/CoupDeGrace.png'),
  P(8017, 'Cut Down', 'Styles/Precision/CutDown/CutDown.png'),
  P(8112, 'Electrocute', 'Styles/Domination/Electrocute/Electrocute.png'),
  P(9923, 'Hail of Blades', 'Styles/Domination/HailOfBlades/HailOfBlades.png'),
  P(8139, 'Taste of Blood', 'Styles/Domination/TasteOfBlood/GreenTerror_TasteOfBlood.png'),
  P(8135, 'Treasure Hunter', 'Styles/Domination/TreasureHunter/TreasureHunter.png'),
  P(8229, 'Arcane Comet', 'Styles/Sorcery/ArcaneComet/ArcaneComet.png'),
  P(8226, 'Manaflow Band', 'Styles/Sorcery/ManaflowBand/ManaflowBand.png'),
  P(8210, 'Transcendence', 'Styles/Sorcery/Transcendence/Transcendence.png'),
  P(8237, 'Scorch', 'Styles/Sorcery/Scorch/Scorch.png'),
  P(8304, 'Magical Footwear', 'Styles/Inspiration/MagicalFootwear/MagicalFootwear.png'),
  P(8345, 'Biscuit Delivery', 'Styles/Inspiration/BiscuitDelivery/BiscuitDelivery.png'),
  P(5008, 'Adaptive Force', 'StatMods/StatModsAdaptiveForceIcon.png'),
  P(5005, 'Attack Speed', 'StatMods/StatModsAttackSpeedIcon.png'),
  P(5001, 'Health Scaling', 'StatMods/StatModsHealthScalingIcon.png'),
];
const STYLES = [
  { id: 8000, name: 'Precision', iconPath: '/lol-game-data/assets/v1/perk-images/Styles/7201_Precision.png' },
  { id: 8100, name: 'Domination', iconPath: '/lol-game-data/assets/v1/perk-images/Styles/7200_Domination.png' },
  { id: 8200, name: 'Sorcery', iconPath: '/lol-game-data/assets/v1/perk-images/Styles/7202_Sorcery.png' },
  { id: 8300, name: 'Inspiration', iconPath: '/lol-game-data/assets/v1/perk-images/Styles/7203_Whimsy.png' },
];
const S = (id, name, file, modes = ['CLASSIC', 'ARAM']) => ({ id, name, gameModes: modes, iconPath: `/lol-game-data/assets/data/spells/icons2d/${file}` });
const SPELLS = [
  S(4, 'Flash', 'summoner_flash.png'), S(14, 'Ignite', 'summonerignite.png'), S(7, 'Heal', 'summoner_heal.png'),
  S(12, 'Teleport', 'summoner_teleport_new.png', ['CLASSIC']), S(21, 'Barrier', 'summonerbarrier.png'),
  S(3, 'Exhaust', 'summoner_exhaust.png'), S(6, 'Ghost', 'summoner_haste.png'), S(1, 'Cleanse', 'summoner_boost.png'),
  S(11, 'Smite', 'summoner_smite.png', ['CLASSIC']), S(32, 'Mark', 'summoner_mark.png', ['ARAM']),
];
let maxEditablePages = 3;
let runePages = [
  { id: 1, name: 'Domination preset', isEditable: false, isValid: true, primaryStyleId: 8100, subStyleId: 8000, selectedPerkIds: [8112, 8139, 8135, 8135, 9111, 8014, 5008, 5008, 5001] },
  { id: 50, name: 'My ADC page', isEditable: true, isValid: true, primaryStyleId: 8000, subStyleId: 8300, selectedPerkIds: [8008, 9111, 9104, 8017, 8304, 8345, 5005, 5008, 5001] },
  { id: 51, name: 'Mid AP', isEditable: true, isValid: true, primaryStyleId: 8200, subStyleId: 8100, selectedPerkIds: [8229, 8226, 8210, 8237, 8139, 8135, 5008, 5008, 5001] },
];
let currentPageId = 50, nextPageId = 60;
const recommended = () => [
  { position: 'BOTTOM', primaryPerkStyleId: 8000, secondaryPerkStyleId: 8100, summonerSpellIds: [4, 7],
    perks: [8005, 9111, 9104, 8014, 8139, 8135, 5005, 5008, 5001].map(id => ({ id })) },
  { position: 'BOTTOM', primaryPerkStyleId: 8000, secondaryPerkStyleId: 8300, summonerSpellIds: [4, 7],
    perks: [8008, 9111, 9104, 8017, 8304, 8345, 5005, 5008, 5001].map(id => ({ id })) },
];

const ME = 2;
// DEMO_FAST=1 shortens every timer, for screenshots and the promo video.
const T = process.env.DEMO_FAST === '1'
  ? { queue: 2500, planning: 4000, ban: 25000, others: 1500, pick: 12000, final: 6000, game: 8000 }
  : { queue: 5000, planning: 10000, ban: 30000, others: 4000, pick: 30000, final: 10000, game: 15000 };
let phase = 'None', lobbyQueue = null, searchStart = 0, rc = null, cs = null, gameEnd = 0;
let roles = { first: 'UNSELECTED', second: 'UNSELECTED' };
const ROLE_QUEUES = new Set([400, 420, 440]);
const rolesReady = () => !ROLE_QUEUES.has(lobbyQueue) || roles.first === 'FILL' || (roles.first !== 'UNSELECTED' && roles.second !== 'UNSELECTED');

function newChampSelect() {
  const now = Date.now();
  const myTeam = [0, 1, 2, 3, 4].map(c => ({ cellId: c, championId: 0, championPickIntent: 0, spell1Id: 4, spell2Id: 14, assignedPosition: ['top', 'jungle', 'middle', 'bottom', 'utility'][c] }));
  const theirTeam = [5, 6, 7, 8, 9].map(c => ({ cellId: c, championId: 0, championPickIntent: 0, assignedPosition: '' }));
  cs = {
    localPlayerCellId: ME, myTeam, theirTeam, bans: { myTeamBans: [], theirTeamBans: [] },
    steps: [
      { name: 'PLANNING', ms: T.planning },
      { name: 'BAN', ms: T.ban, mine: { id: 1, type: 'ban' } },
      { name: 'OTHERS', ms: T.others },
      { name: 'PICK', ms: T.pick, mine: { id: 2, type: 'pick' } },
      { name: 'FINALIZATION', ms: T.final },
    ],
    step: 0, stepStart: now,
    myBan: { id: 1, actorCellId: ME, type: 'ban', championId: 0, completed: false, isInProgress: false },
    myPick: { id: 2, actorCellId: ME, type: 'pick', championId: 0, completed: false, isInProgress: false },
    otherPicks: [],
  };
}

function advance() {
  const now = Date.now();
  if (phase === 'Matchmaking' && now - searchStart > T.queue) { phase = 'ReadyCheck'; rc = { start: now, response: 'None' }; }
  if (phase === 'ReadyCheck') {
    if (rc.response === 'Accepted' && now - rc.acceptedAt > 1500) { phase = 'ChampSelect'; newChampSelect(); }
    else if (rc.response === 'Declined' || now - rc.start > 12000) { phase = 'Lobby'; }
  }
  if (phase === 'ChampSelect') {
    let st = cs.steps[cs.step];
    const action = st.mine && (st.mine.type === 'ban' ? cs.myBan : cs.myPick);
    if (action?.completed || now - cs.stepStart > st.ms) {
      if (action && !action.completed) { phase = 'Lobby'; console.log('[demo] timer ran out — dodged'); return; }
      if (st.name === 'FINALIZATION') { phase = 'InProgress'; gameEnd = now + T.game; return; }
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
    // like the real client: the ban already shows as in progress while players declare picks
    cs.myBan.isInProgress = (st.name === 'PLANNING' || st.name === 'BAN') && !cs.myBan.completed;
    cs.myPick.isInProgress = st.name === 'PICK' && !cs.myPick.completed;
    const me = cs.myTeam[ME];
    me.championPickIntent = cs.myPick.championId;
    if (cs.myPick.completed) me.championId = cs.myPick.championId;
  }
  if (phase === 'InProgress' && now > gameEnd) phase = 'EndOfGame';
}

function sessionJson() {
  const st = cs.steps[cs.step];
  // Like the real client: a hover shows up in the session about a second after it was accepted,
  // and the timer is only re-stamped when something happens, not on every read.
  const lag = a => Date.now() < (a.showAt || 0) ? { ...a, championId: a.shownChamp } : a;
  const stamp = Math.max(cs.stepStart, cs.timerStamp || 0);
  const timerPhase = st.name === 'PLANNING' ? 'PLANNING' : st.name === 'FINALIZATION' ? 'FINALIZATION' : 'BAN_PICK';
  return {
    localPlayerCellId: ME, myTeam: cs.myTeam.map(p => p.cellId === ME && Date.now() < (cs.myPick.showAt || 0) ? { ...p, championPickIntent: cs.myPick.shownChamp } : p), theirTeam: cs.theirTeam, bans: cs.bans,
    actions: [[lag(cs.myBan)], cs.otherPicks, [lag(cs.myPick)]],
    timer: { phase: timerPhase, totalTimeInPhase: st.ms, adjustedTimeLeftInPhase: Math.max(0, st.ms - (stamp - cs.stepStart)), internalNowInEpochMs: stamp },
  };
}

function taken() {
  return new Set([...cs.bans.myTeamBans, ...cs.bans.theirTeamBans, ...cs.myTeam.map(p => p.championId), ...cs.theirTeam.map(p => p.championId)]);
}

// The client's game-data paths map onto Community Dragon's mirror (which lowercases them).
function asset(p, res) {
  const rel = p.replace('/lol-game-data/assets/', '').toLowerCase();
  proxy(`https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/${rel}`, res);
}

function icon(id, res) {
  proxy(`https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${id}.png`, res);
}

function proxy(url, res) {
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
    if (m === 'GET' && p.startsWith('/lol-game-data/assets/') && p.endsWith('.png')) return asset(p, res);
    if (route === 'GET /lol-game-data/assets/v1/summoner-spells.json') return json(res, 200, SPELLS);
    if (route === 'GET /lol-gameflow/v1/session') return json(res, 200, { map: { id: 11, gameMode: 'CLASSIC' } });

    // rune pages
    if (route === 'GET /lol-perks/v1/perks') return json(res, 200, PERKS);
    if (route === 'GET /lol-perks/v1/styles') return json(res, 200, STYLES);
    if (route === 'GET /lol-perks/v1/pages') return json(res, 200, runePages.map(pg => ({ ...pg, current: pg.id === currentPageId })));
    if (route === 'GET /lol-perks/v1/currentpage') return json(res, 200, runePages.find(pg => pg.id === currentPageId));
    if (route === 'PUT /lol-perks/v1/currentpage') {
      if (!runePages.some(pg => pg.id === body)) return json(res, 404, { message: 'No such page' });
      currentPageId = body; return json(res, 204);
    }
    if (route === 'POST /lol-perks/v1/pages') {
      if (runePages.filter(pg => pg.isEditable).length >= maxEditablePages) return json(res, 400, { message: 'Max pages reached' });
      const pg = { id: nextPageId++, isEditable: true, isValid: true, name: body.name, primaryStyleId: body.primaryStyleId, subStyleId: body.subStyleId, selectedPerkIds: body.selectedPerkIds };
      runePages.push(pg); if (body.current) currentPageId = pg.id;
      return json(res, 200, pg);
    }
    if ((match = /^\/lol-perks\/v1\/pages\/(\d+)$/.exec(p)) && m === 'PUT') {
      const pg = runePages.find(x => x.id === Number(match[1]));
      if (!pg?.isEditable) return json(res, 400, { message: 'Page is not editable' });
      Object.assign(pg, { name: body.name, primaryStyleId: body.primaryStyleId, subStyleId: body.subStyleId, selectedPerkIds: body.selectedPerkIds });
      return json(res, 201, pg);
    }
    if ((match = /^\/lol-perks\/v1\/recommended-pages\/champion\/(\d+)\/position\/(\w+)\/map\/(\d+)$/.exec(p))) return json(res, 200, recommended());
    if (route === 'GET /lol-perks/v1/inventory') return json(res, 200, { ownedPageCount: maxEditablePages });
    if (route === 'POST /mock/max-pages') { maxEditablePages = body.n; return json(res, 204); } // test hook

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
      if (route === 'PATCH /lol-champ-select/v1/session/my-selection') {
        const me = cs.myTeam[ME];
        if (body.spell1Id) me.spell1Id = body.spell1Id;
        if (body.spell2Id) me.spell2Id = body.spell2Id;
        return json(res, 204);
      }
      // Like the real client in the user's game: these lists come back empty or missing.
      if (route === 'GET /lol-champ-select/v1/pickable-champion-ids') return json(res, 200, []);
      // only owned champions, although anything can be banned
      if (route === 'GET /lol-champ-select/v1/bannable-champion-ids') return json(res, 200, CHAMPS.filter(c => c.id !== 777 && c.id !== 238).map(c => c.id));
      if ((match = /^\/lol-champ-select\/v1\/session\/actions\/(\d+)(\/complete)?$/.exec(p))) {
        const a = [cs.myBan, cs.myPick].find(x => x.id === Number(match[1]));
        if (!a) return json(res, 404, { message: 'No such action' });
        if (m === 'PATCH') {
          if (body.championId && taken().has(body.championId)) return json(res, 500, { message: 'Champion is not available' });
          if (body.championId) {
            if (!('completed' in body)) { a.shownChamp = a.championId; a.showAt = Date.now() + 900; }
            a.championId = body.championId;
          }
          cs.timerStamp = Date.now();
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
