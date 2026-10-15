// ============================================================
// gen-icon.js —— 生成应用图标 icon.ico / icon.png（纯 Node，零第三方依赖）
// ============================================================
// 这个文件「画」出一个图标：圆角渐变方块 + 白色对勾，然后编码成 PNG 和 ICO。
// 学习价值：不依赖任何库，手写了三件底层的事——
//   1) CRC32 校验算法（PNG 文件格式要求每个数据块都带 CRC 校验值）
//   2) PNG 文件编码（签名 + IHDR/IDAT/IEND 数据块 + zlib 压缩像素数据）
//   3) 用「有符号距离场（SDF）」逐像素判断每个点在图形内/外，抗锯齿画图
const zlib = require('zlib');   // Node 内置压缩库（PNG 的像素数据用 zlib 压缩）
const fs = require('fs');
const path = require('path');

// ---------- CRC32 ----------
// PNG 格式里，每个「块（chunk）」后面都要跟一个 CRC32 校验值，
// 用来验证数据没被损坏。这里是标准的 CRC32 查表法实现。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

// 对一段 buffer 计算 CRC32 值
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- PNG 编码 ----------
// PNG 文件 = 固定签名 + 若干个「块」。每个块结构：
//   [4 字节：数据长度][4 字节：块类型如 IHDR/IDAT/IEND][数据][4 字节：CRC 校验]
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);   // 大端写长度
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); // CRC 覆盖「类型+数据」
  return Buffer.concat([len, t, data, crc]);
}

// 把 RGBA 像素数组编码成完整 PNG 文件
function encodePNG(width, height, rgba) {
  // PNG 固定 8 字节签名，标识「这是 PNG」
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  // IHDR：图像头信息（宽、高、位深、颜色类型）
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深：每个通道 8 位
  ihdr[9] = 6;   // 颜色类型：6 = RGBA（带透明通道）
  // 逐行填像素。PNG 要求每行开头 1 字节是「过滤器类型」，这里用 0（None，不过滤）
  const stride = width * 4;                 // 每行像素字节数
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;              // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),   // 像素数据用 zlib 压缩（level 9 最高压缩）
    chunk('IEND', Buffer.alloc(0)),                        // 结束标记
  ]);
}

// ---------- 绘制（圆角方块 + 对勾）----------
// 有符号距离场（Signed Distance Field）函数：输入一个点，返回它到图形边界的「有符号距离」。
// 返回负数 = 点在图形内，正数 = 在外，0 = 在边界上。配合 cov() 做抗锯齿。

// 圆角矩形距离场：(px,py) 是采样点，(cx,cy) 中心，(hw,hh) 半宽半高，r 圆角半径
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// 线段距离场：点 (px,py) 到线段 (ax,ay)-(bx,by) 的最短距离
function sdSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby))); // 投影到线段上的比例，夹在 [0,1]
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

// 把「距离」转成「覆盖率」（0~1）：距离为 0（正好在边界）时覆盖率 0.5，实现抗锯齿
function cov(d) { return Math.max(0, Math.min(1, 0.5 - d)); }

// 画一整个图标（size×size 像素），返回 PNG buffer
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const m = size * 0.10;                 // 外留白（图标四周留边）
  const c = size / 2;                    // 中心坐标
  const rectHW = size / 2 - m;           // 方块半宽
  const rr = size * 0.22;                // 圆角半径
  const thick = size * 0.09;             // 对勾线宽

  // 对勾三个顶点（用「占整体尺寸的比例」表示，方便任意尺寸缩放）
  const P = [
    [0.31, 0.53],
    [0.45, 0.67],
    [0.70, 0.38],
  ];

  // 渐变颜色：上浅下深（蓝紫色系）
  const top = [110, 125, 255], bottom = [76, 95, 240];
  const white = [255, 255, 255];

  // 逐像素扫描
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;  // 采样点取像素中心，抗锯齿更平滑
      const dRect = sdRoundRect(px, py, c, c, rectHW, rectHW, rr);
      const aRect = cov(dRect);          // 方块覆盖率
      if (aRect <= 0) continue;          // 完全在方块外 → 透明，跳过

      // 根据 y 坐标在上下颜色之间线性插值（实现垂直渐变）
      const t = y / size;
      const rrCol = [top[0] + (bottom[0] - top[0]) * t, top[1] + (bottom[1] - top[1]) * t, top[2] + (bottom[2] - top[2]) * t];

      // 对勾由两段线段组成，取到两条线段的最短距离
      let dCheck = Infinity;
      dCheck = Math.min(dCheck, sdSeg(px, py, P[0][0]*size, P[0][1]*size, P[1][0]*size, P[1][1]*size));
      dCheck = Math.min(dCheck, sdSeg(px, py, P[1][0]*size, P[1][1]*size, P[2][0]*size, P[2][1]*size));
      const aCheck = cov(dCheck - thick / 2); // 对勾覆盖率（减去线宽一半，形成线的厚度）

      // 在方块颜色和白色之间按对勾覆盖率混合 → 画白色对勾
      const col = [0, 0, 0];
      for (let k = 0; k < 3; k++) col[k] = Math.round(rrCol[k] + (white[k] - rrCol[k]) * aCheck);

      // 写入像素：RGB + 透明度（透明通道用方块覆盖率）
      const i = (y * size + x) * 4;
      rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; rgba[i + 3] = Math.round(aRect * 255);
    }
  }
  return encodePNG(size, size, rgba);
}

// ---------- 打包为 ICO（多尺寸）----------
// ICO 文件 = 文件头 + 目录项（每张图一个）+ 各图片数据。
// 现代 ICO 支持直接内嵌 PNG，所以这里把多张不同尺寸的 PNG 塞进一个 ICO，
// 让 Windows 在不同缩放/场景下自动选合适尺寸。
function buildICO(sizes) {
  const pngs = sizes.map((s) => ({ size: s, png: drawIcon(s) }));
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留字段，必须 0
  header.writeUInt16LE(1, 2); // 类型：1 = 图标（ICO）
  header.writeUInt16LE(count, 4); // 图片数量

  const entries = [];
  let offset = 6 + 16 * count;   // 数据区起始偏移 = 头(6) + 目录项(16×数量)
  for (const p of pngs) {
    const e = Buffer.alloc(16);  // 每个目录项 16 字节
    e.writeUInt8(p.size === 256 ? 0 : p.size, 0); // 宽（256 用 0 表示，ICO 的 256 约定）
    e.writeUInt8(p.size === 256 ? 0 : p.size, 1); // 高
    e.writeUInt8(0, 2);  // 调色板颜色数（PNG 内嵌时用 0）
    e.writeUInt8(0, 3);  // 保留
    e.writeUInt16LE(1, 4); // 平面数
    e.writeUInt16LE(32, 6); // 位深（32 位带透明）
    e.writeUInt32LE(p.png.length, 8); // 图片数据字节数
    e.writeUInt32LE(offset, 12); // 图片数据在文件中的偏移
    entries.push(e);
    offset += p.png.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

// 生成最终文件：ICO（含 6 个尺寸）+ 单独的 256px PNG
const dir = __dirname;
fs.writeFileSync(path.join(dir, 'icon.ico'), buildICO([256, 128, 64, 48, 32, 16]));
fs.writeFileSync(path.join(dir, 'icon.png'), drawIcon(256));
console.log('已生成 icon.ico 和 icon.png');
