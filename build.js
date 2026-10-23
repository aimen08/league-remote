// Builds dist/LeagueRemote.exe — one file with Node.js, the server and the phone app inside.
// Usage: npm install && npm run build
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');
const { inject } = require('postject');

const root = __dirname;
const dist = path.join(root, 'dist');
const exe = path.join(dist, 'LeagueRemote.exe');
const ASSETS = ['index.html', 'pair.html', 'manifest.webmanifest', 'icon.svg'];

(async () => {
  if (process.platform !== 'win32') throw new Error('Build on Windows to get a Windows .exe');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist);

  // 1. Bundle the server and its one dependency (qrcode) into a single script.
  esbuild.buildSync({
    entryPoints: [path.join(root, 'server.js')],
    bundle: true, platform: 'node', target: 'node22', format: 'cjs',
    outfile: path.join(dist, 'bundle.js'),
    logLevel: 'warning',
  });

  // 2. Turn it into a Node single-executable blob, with the phone app files as assets.
  const seaConfig = {
    main: path.join(dist, 'bundle.js'),
    output: path.join(dist, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets: Object.fromEntries(ASSETS.map(f => [f, path.join(root, 'public', f)])),
  };
  fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(dist, 'sea-config.json')], { stdio: 'inherit' });

  // 3. Copy node.exe and inject the blob.
  fs.copyFileSync(process.execPath, exe);
  await inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(seaConfig.output), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });

  for (const f of ['bundle.js', 'sea-prep.blob', 'sea-config.json']) fs.rmSync(path.join(dist, f));
  const mb = (fs.statSync(exe).size / 1048576).toFixed(0);
  console.log(`\nBuilt ${path.relative(root, exe)} (${mb} MB, Node ${process.version})`);
})().catch(e => { console.error(e); process.exit(1); });
