// Renders assets/icon.svg into the exe icon (assets/icon.ico) and the phone app icons (public/*.png).
// Usage: npm run icons   (outputs are committed, so this only needs re-running after changing the design)
'use strict';
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.join(__dirname, '..');
const full = fs.readFileSync(path.join(root, 'assets/icon.svg'), 'utf8');
const small = fs.readFileSync(path.join(root, 'assets/icon-small.svg'), 'utf8');
const render = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

// .ico with PNG-compressed images (supported by Windows Vista and later).
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);     // width (0 means 256)
    header.writeUInt8(size >= 256 ? 0 : size, e + 1); // height
    header.writeUInt16LE(1, e + 4);                    // colour planes
    header.writeUInt16LE(32, e + 6);                   // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(i => i.png)]);
}

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
fs.writeFileSync(path.join(root, 'assets/icon.ico'),
  ico(sizes.map(size => ({ size, png: render(size <= 32 ? small : full, size) }))));

fs.writeFileSync(path.join(root, 'public/icon-192.png'), render(full, 192));
fs.writeFileSync(path.join(root, 'public/icon-512.png'), render(full, 512));
// iOS rounds the corners itself and fills transparent ones with black, so give it a square tile.
fs.writeFileSync(path.join(root, 'public/apple-touch-icon.png'), render(full.replace('rx="56"', 'rx="0"'), 180));
fs.copyFileSync(path.join(root, 'assets/icon.svg'), path.join(root, 'public/icon.svg'));
console.log('Icons written: assets/icon.ico, public/icon-192.png, public/icon-512.png, public/apple-touch-icon.png, public/icon.svg');
