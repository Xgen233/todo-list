// 生成图标 icon.ico / icon.png（纯 Node，无第三方依赖）
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- PNG 编码 ----------
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘制（圆角方块 + 对勾）----------
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby)));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

function cov(d) { return Math.max(0, Math.min(1, 0.5 - d)); }

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const m = size * 0.10;                 // 外留白
  const c = size / 2;
  const rectHW = size / 2 - m;           // 半宽
  const rr = size * 0.22;                // 圆角半径
  const thick = size * 0.09;             // 对勾线宽

  // 对勾三点（比例坐标）
  const P = [
    [0.31, 0.53],
    [0.45, 0.67],
    [0.70, 0.38],
  ];

  // 渐变：上浅下深
  const top = [110, 125, 255], bottom = [76, 95, 240];
  const white = [255, 255, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const dRect = sdRoundRect(px, py, c, c, rectHW, rectHW, rr);
      const aRect = cov(dRect);
      if (aRect <= 0) continue;

      const t = y / size;
      const rrCol = [top[0] + (bottom[0] - top[0]) * t, top[1] + (bottom[1] - top[1]) * t, top[2] + (bottom[2] - top[2]) * t];

      let dCheck = Infinity;
      dCheck = Math.min(dCheck, sdSeg(px, py, P[0][0]*size, P[0][1]*size, P[1][0]*size, P[1][1]*size));
      dCheck = Math.min(dCheck, sdSeg(px, py, P[1][0]*size, P[1][1]*size, P[2][0]*size, P[2][1]*size));
      const aCheck = cov(dCheck - thick / 2);

      const col = [0, 0, 0];
      for (let k = 0; k < 3; k++) col[k] = Math.round(rrCol[k] + (white[k] - rrCol[k]) * aCheck);

      const i = (y * size + x) * 4;
      rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; rgba[i + 3] = Math.round(aRect * 255);
    }
  }
  return encodePNG(size, size, rgba);
}

// ---------- 打包为 ICO（多尺寸）----------
function buildICO(sizes) {
  const pngs = sizes.map((s) => ({ size: s, png: drawIcon(s) }));
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + 16 * count;
  for (const p of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(p.size === 256 ? 0 : p.size, 0); // width
    e.writeUInt8(p.size === 256 ? 0 : p.size, 1); // height
    e.writeUInt8(0, 2);  // palette
    e.writeUInt8(0, 3);  // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(p.png.length, 8); // size
    e.writeUInt32LE(offset, 12); // offset
    entries.push(e);
    offset += p.png.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'icon.ico'), buildICO([256, 128, 64, 48, 32, 16]));
fs.writeFileSync(path.join(dir, 'icon.png'), drawIcon(256));
console.log('已生成 icon.ico 和 icon.png');
