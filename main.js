// Entry point of LeagueRemote.exe. Opened from Explorer, it starts a hidden copy of itself that lives
// in the system tray, waits until that copy is up, and closes its window. With --foreground (or when
// not attached to a console window, e.g. in tests) it runs the server directly, like `npm start`.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let isExe = false;
try { isExe = require('node:sea').isSea(); } catch {}
const args = process.argv.slice(2);
const launch = isExe && process.platform === 'win32' && process.stdout.isTTY &&
  !args.includes('--background') && !args.includes('--foreground') && !process.env.LEAGUE_REMOTE_FOREGROUND;

if (!launch) {
  require('./server');
} else {
  process.stdout.write('\x1b]0;League Remote\x07\n  League Remote is starting in the system tray...\n');
  const child = spawn(process.execPath, ['--background', ...args], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  const dataDir = process.env.LEAGUE_REMOTE_DATA || path.join(process.env.APPDATA || os.homedir(), 'LeagueRemote');
  const started = Date.now();
  // The tray copy records itself in instance.json once it is serving.
  const timer = setInterval(() => {
    let ok = false;
    try { ok = JSON.parse(fs.readFileSync(path.join(dataDir, 'instance.json'), 'utf8')).pid === child.pid; } catch {}
    if (ok) {
      process.stdout.write('  Running. Look for the League Remote icon in the system tray.\n');
      clearInterval(timer);
      setTimeout(() => process.exit(0), 1200);
    } else if (Date.now() - started > 20000) {
      process.stdout.write('  It is taking longer than usual. If no icon appears in the tray, run LeagueRemote.exe --foreground to see why.\n');
      clearInterval(timer);
      setTimeout(() => process.exit(1), 8000);
    }
  }, 300);
  child.on('exit', code => { if (code) { clearInterval(timer); setTimeout(() => process.exit(1), 300); } }); // it shows its own error box
}
