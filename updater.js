// Self-update for LeagueRemote.exe: finds the latest GitHub release, downloads it next to the
// running exe, checks its SHA-256 against what GitHub reports, then swaps the files.
// A running .exe can't be overwritten on Windows, but it can be renamed — so the old one becomes
// LeagueRemote.exe.old (deleted on the next start) and the new one takes its name.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const REPO = 'aimen08/league-remote';
const ASSET = 'LeagueRemote.exe';
// Overridable for testing against a local fake release; plain http is only allowed then.
const API_URL = process.env.LEAGUE_REMOTE_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const allowHttp = !!process.env.LEAGUE_REMOTE_UPDATE_URL;

// True when version a (like "1.2.0" or "v1.2.0") is newer than b.
function isNewer(a, b) {
  const parse = v => String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

function request(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return reject(new Error(`refusing non-https URL ${url}`));
    const req = (u.protocol === 'https:' ? https : http).get(u, {
      headers: { 'User-Agent': 'LeagueRemote-updater', Accept: 'application/vnd.github+json, application/octet-stream' },
      timeout: 20000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(request(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} from ${u.host}`)); }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

async function getJson(url) {
  const res = await request(url);
  let body = '';
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

// The newest release if it is newer than `current`, else null.
async function checkForUpdate(current) {
  const rel = await getJson(API_URL);
  if (!rel || rel.draft || rel.prerelease || !isNewer(rel.tag_name, current)) return null;
  const asset = (rel.assets || []).find(a => a.name === ASSET);
  if (!asset) return null;
  // GitHub reports a digest for each asset; older releases carry the hash in the notes instead.
  const sha256 = (/^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '') || /SHA-256:\s*`?([0-9a-f]{64})/i.exec(rel.body || '') || [])[1];
  if (!sha256) return null; // never install something we can't verify
  return { version: String(rel.tag_name).replace(/^v/, ''), url: asset.browser_download_url, size: asset.size, sha256: sha256.toLowerCase() };
}

// Downloads the update next to the exe and verifies it. Returns the staged file's path.
async function downloadUpdate(info, exePath) {
  const staged = exePath + '.new';
  try { fs.rmSync(staged, { force: true }); } catch {}
  const res = await request(info.url);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(staged);
  let writeError = null;
  out.on('error', e => { writeError = e; out.emit('drain'); }); // e.g. read-only folder, disk full, file locked
  let size = 0;
  try {
    for await (const chunk of res) {
      if (writeError) throw writeError;
      hash.update(chunk);
      size += chunk.length;
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    }
    if (writeError) throw writeError;
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    if (size !== info.size) throw new Error(`size mismatch (${size} vs ${info.size} bytes)`);
    const got = hash.digest('hex');
    if (got !== info.sha256) throw new Error('checksum mismatch — download discarded');
    return staged;
  } catch (e) {
    out.destroy();
    try { fs.rmSync(staged, { force: true }); } catch {}
    throw e;
  }
}

// Puts the staged exe in place of the running one. Rolls back if the second rename fails.
function applyUpdate(staged, exePath) {
  const old = exePath + '.old';
  try { fs.rmSync(old, { force: true }); } catch {}
  fs.renameSync(exePath, old);
  try {
    fs.renameSync(staged, exePath);
  } catch (e) {
    fs.renameSync(old, exePath);
    throw e;
  }
}

// Removes the previous version left behind by an update (it may still be exiting, so retry).
function cleanupOld(exePath) {
  const old = exePath + '.old';
  let tries = 0;
  const attempt = () => {
    try { fs.rmSync(old, { force: true }); } catch { if (++tries < 10) setTimeout(attempt, 1000); }
  };
  attempt();
  try { fs.rmSync(exePath + '.new', { force: true }); } catch {}
}

module.exports = { isNewer, checkForUpdate, downloadUpdate, applyUpdate, cleanupOld };
