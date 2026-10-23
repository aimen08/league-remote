// The console window: a QR code to scan, plus live League / phone status.
// Only used when running in a real terminal; otherwise the server just prints log lines.
'use strict';
const QRCode = require('qrcode');

const ESC = '\x1b[';
const c = {
  reset: ESC + '0m', bold: ESC + '1m', dim: ESC + '2m',
  green: ESC + '92m', red: ESC + '91m', yellow: ESC + '93m', gold: ESC + '33m', cyan: ESC + '96m',
};
const PHASES = {
  None: 'In the client', Lobby: 'In a lobby', Matchmaking: 'In queue', ReadyCheck: 'Match found!',
  ChampSelect: 'Champ select', GameStart: 'Game starting', InProgress: 'In game', Reconnect: 'Reconnect needed',
  WaitingForStats: 'Game over', PreEndOfGame: 'Game over', EndOfGame: 'Game over', Loading: 'Client loading…',
};

// A QR code drawn with half-block characters (two rows per text line), black on white.
function qrLines(text) {
  const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'L' }).modules;
  const margin = 2;
  const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && data[y * size + x];
  const lines = [];
  for (let y = -margin; y < size + margin; y += 2) {
    let line = '';
    for (let x = -margin; x < size + margin; x++) {
      const top = dark(x, y), bottom = dark(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(ESC + '30;107m' + line + c.reset);
  }
  return lines;
}

const visibleLength = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;

function createConsoleUI() {
  if (!process.stdout.isTTY) return null;
  const recent = [];
  let info = null, last = '', qrCache = { url: null, lines: [] };

  const origLog = console.log.bind(console);
  console.log = (...args) => {
    const time = new Date().toTimeString().slice(0, 5);
    recent.push(`${c.dim}${time}${c.reset} ${args.join(' ')}`);
    if (recent.length > 6) recent.shift();
    draw();
  };
  process.stdout.write(ESC + '?25l' + '\x1b]0;League Remote\x07'); // hide cursor, set window title
  process.on('exit', () => process.stdout.write(ESC + '?25h' + c.reset));
  process.stdout.on('resize', () => { last = ''; draw(); });

  function statusLines() {
    const { urls, key, league, phone, settings, version, update = {} } = info;
    const dot = (ok, warn) => ok ? `${c.green}●${c.reset}` : warn ? `${c.yellow}●${c.reset}` : `${c.red}●${c.reset}`;
    const updateText = {
      checking: 'checking for updates…',
      latest: 'up to date',
      available: `${c.yellow}version ${update.version} available on GitHub${c.reset}`,
      downloading: `${c.yellow}downloading update ${update.version}…${c.reset}`,
      ready: `${c.yellow}update ${update.version} installs when you're not in queue or champ select${c.reset}`,
      installing: `${c.yellow}starting ${update.version}…${c.reset}`,
      failed: 'update check failed — will retry later',
      off: 'updates off',
    }[update.status] || '';
    const lines = [
      `${c.bold}${c.gold}LEAGUE REMOTE${c.reset} ${c.dim}v${version}${updateText ? ` · ${updateText}` : ''}${c.reset}`,
      '',
      `League   ${dot(league.connected)} ${league.connected
        ? `${c.bold}Connected${c.reset}${league.summoner ? ` · ${league.summoner}` : ''}`
        : `${c.bold}Not found${c.reset} ${c.dim}— open the League client${c.reset}`}`,
      league.connected ? `         ${c.dim}${PHASES[league.phase] || league.phase || ''}${c.reset}` : '',
      `Phone    ${dot(phone.connected, phone.ever)} ${phone.connected
        ? `${c.bold}Connected${c.reset} ${c.dim}(${phone.ip})${c.reset}`
        : phone.ever ? `${c.bold}Not connected${c.reset} ${c.dim}— phone asleep?${c.reset}` : `${c.bold}Waiting${c.reset} ${c.dim}— scan the QR code${c.reset}`}`,
      '',
      `${c.dim}Scan with your phone camera (same Wi-Fi) or open:${c.reset}`,
      ...(urls.length ? urls.map(u => `  ${c.cyan}${u}${c.reset}`) : [`  ${c.red}No network found — connect this PC to Wi-Fi/Ethernet${c.reset}`]),
      `${c.dim}Pairing code:${c.reset} ${c.bold}${key}${c.reset}`,
      '',
      `${c.dim}Auto-accept ${settings.autoAccept ? c.green + 'on' : 'off'}${c.reset}`,
    ];
    if (recent.length) lines.push('', `${c.dim}Recent:${c.reset}`, ...recent);
    lines.push('', `${c.dim}Keep this window open while you play. Close it to stop.${c.reset}`);
    return lines;
  }

  function draw() {
    if (!info) return;
    const url = info.urls[0];
    if (url && qrCache.url !== url) qrCache = { url, lines: qrLines(url) };
    const qr = qrCache.lines;
    const status = statusLines();
    const qrWidth = qr.length ? visibleLength(qr[0]) : 0;
    const cols = process.stdout.columns || 80;
    let out;
    if (qr.length && cols >= qrWidth + 4 + 56) {
      // QR on the left, status on the right
      const rows = Math.max(qr.length, status.length);
      out = [];
      for (let i = 0; i < rows; i++) {
        const left = qr[i] || ' '.repeat(qrWidth);
        out.push('  ' + left + '   ' + (status[i] || ''));
      }
    } else {
      out = [...qr.map(l => '  ' + l), '', ...status.map(l => '  ' + l)];
    }
    const frame = '\n' + out.join('\n') + '\n';
    if (frame === last) return;
    last = frame;
    process.stdout.write(ESC + '2J' + ESC + '3J' + ESC + 'H' + frame);
  }

  return {
    update(next) { info = next; draw(); },
    error(msg) { origLog(msg); },
  };
}

module.exports = { createConsoleUI, qrLines };
