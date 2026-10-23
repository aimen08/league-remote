// System tray icon for LeagueRemote.exe. Node has no tray API, so a hidden Windows PowerShell
// process (always present on Windows) shows the icon and menu and reports clicks on its stdout.
'use strict';
const { spawn } = require('child_process');

const ps = script => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
  '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const psString = s => `'${String(s).replace(/'/g, "''")}'`;

// onShow: "Show QR code and status" or a double-click; onQuit: "Quit League Remote".
// statusPath: a text file whose first line becomes the tooltip (Windows allows 63 characters).
function startTray({ iconPath, statusPath, onShow, onQuit }) {
  const child = ps(`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$parent = ${process.pid}
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = New-Object System.Drawing.Icon(${psString(iconPath)})
$tray.Text = 'League Remote'
$tray.Visible = $true
function Say($word) { [Console]::Out.WriteLine($word); [Console]::Out.Flush() }
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$show = $menu.Items.Add('Show QR code and status')
$show.Font = New-Object System.Drawing.Font($show.Font, [System.Drawing.FontStyle]::Bold)
$show.add_Click({ Say 'show' })
[void]$menu.Items.Add('-')
$quit = $menu.Items.Add('Quit League Remote')
$quit.add_Click({ Say 'quit'; $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ Say 'show' })
$tray.add_BalloonTipClicked({ Say 'show' })
$tray.ShowBalloonTip(6000, 'League Remote is running', 'It lives here in the tray. Double-click the icon to show the QR code.', [System.Windows.Forms.ToolTipIcon]::Info)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.add_Tick({
  # leave together with League Remote, so no orphaned icon is left behind
  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { $tray.Visible = $false; [System.Windows.Forms.Application]::Exit(); return }
  try { $t = [IO.File]::ReadAllText(${psString(statusPath)}).Trim(); if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }; if ($t -and $tray.Text -ne $t) { $tray.Text = $t } } catch {}
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
`);
  let buf = '';
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const word = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (word === 'show') onShow();
      if (word === 'quit') onQuit();
    }
  });
  child.on('error', () => {}); // no tray if PowerShell is unavailable; the app keeps working
  return child;
}

// A plain Windows message box, for errors when there is no console window to print to.
function showMessage(title, text) {
  return new Promise(resolve => {
    const child = ps(`Add-Type -AssemblyName System.Windows.Forms
[void][System.Windows.Forms.MessageBox]::Show(${psString(text)}, ${psString(title)}, 'OK', 'Warning')`);
    child.on('exit', resolve);
    child.on('error', resolve);
  });
}

module.exports = { startTray, showMessage };
