const { app, BrowserWindow, Menu, ipcMain, Tray, nativeImage, nativeTheme, globalShortcut, clipboard, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

let mainWin = null;
let widgetWin = null;
let tray = null;
let isQuitting = false;

// ---------- 配置（持久化到 userData/config.json） ----------
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); } catch {}
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

function setAutoOpenWidget(enabled) {
  const cfg = loadConfig();
  cfg.autoOpenWidget = !!enabled;
  saveConfig(cfg);
  app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--autostart'] });
}

function setWidgetClickThrough(enabled) {
  const cfg = loadConfig();
  cfg.widgetClickThrough = !!enabled;
  saveConfig(cfg);
  if (widgetWin) widgetWin.setIgnoreMouseEvents(!!enabled, { forward: true });
  sendWidgetState();
}

// 校验保存的桌贴坐标是否仍落在某个显示器工作区内（换显示器/改分辨率后可能越界）
function clampWidgetPos(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea;
    if (x >= wa.x && x < wa.x + wa.width && y >= wa.y && y < wa.y + wa.height) {
      return { x, y };
    }
  }
  return null;
}

// 保存桌贴窗口当前位置，重开时还原
function saveWidgetPos() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const [x, y] = widgetWin.getPosition();
  const cfg = loadConfig();
  cfg.widgetPos = { x, y };
  saveConfig(cfg);
}

// ---------- AI 总结 ----------
function getAIConfig() {
  const cfg = loadConfig().ai || {};
  return {
    apiKey: cfg.apiKey || '',
    baseURL: cfg.baseURL || 'https://api.deepseek.com',
    model: cfg.model || 'deepseek-chat',
    mode: cfg.mode || 'auto',
  };
}

function saveAIConfig(ai) {
  saveConfig(Object.assign({}, loadConfig(), { ai }));
}

function simulateCopy() {
  return new Promise((resolve) => {
    const ps = `$w = New-Object -ComObject WScript.Shell; $w.SendKeys('^c'); Start-Sleep -Milliseconds 250`;
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, () => resolve());
  });
}

async function captureSelection() {
  await simulateCopy();
  await new Promise((r) => setTimeout(r, 120));
  return clipboard.readText().trim();
}

function notifyRenderer(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

async function callLLM(ai, text) {
  const url = ai.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ai.apiKey },
    body: JSON.stringify({
      model: ai.model,
      messages: [
        { role: 'system', content: '你是待办事项总结助手。把用户提供的文字总结成一条简短待办事项（不超过30字），直接输出总结内容，不要任何解释、前缀或引号。' },
        { role: 'user', content: text.slice(0, 4000) },
      ],
      temperature: 0.3,
      max_tokens: 120,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + (t ? ' ' + t.slice(0, 160) : ''));
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('返回内容为空');
  return content.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
}

// 中文停用字/词：过滤掉虚词，避免词频被「的/了/是/我」等污染
const STOP_CHARS = new Set('的一是在有和与或及也都就还而但若如因所以此等之其中又更最很太过于吗呢吧啊呀哦么着把被让给向从对到为去来上下前后里外这那哪个些什么怎么怎样如何为什么没有不是不会可以应该需要能够可能已经正在将要是否');
const STOP_BIGRAMS = new Set(['因为','所以','但是','如果','然后','而且','或者','以及','就是','不是','没有','可以','应该','需要','已经','正在','将要','这个','那个','这些','那些','什么','怎么','如何','为什么','由于','关于','对于','通过','根据','虽然','即使','尽管','不过','然而','因此','于是','接着','首先','其次','最后','另外','总之','例如','比如','就是说','尤其','特别','时候','东西','事情','问题','方面','情况']);
// 常见待办动作动词：含其中一个的从句更可能是「要做的事」
const ACTION = new Set(['买','做','写','发','送','订','约','交','修','改','整理','收拾','打扫','取','拿','寄','付','报名','申请','预约','核对','检查','跟进','回复','沟通','汇报','培训','面试','出差','拜访','购买','下载','安装','升级','备份','打印','扫描','签字','盖章','报销','付款','转账','准备','完成','提交','更新','处理','联系','确认','安排','参加','开会','提醒','学习','复习','读','换','补','办理','补办','收集','汇总','填写','发放','领取','参会','预留','举行','组织','注册','报到','签到','布置','上交','递交','缴费']);

function summarizeOffline(text) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  const MAX = 40;
  if (src.length <= MAX) return src;

  // 按标点切从句
  const clauses = src.split(/[，,、。！？!?；;]+/).map(s => s.trim()).filter(Boolean);
  if (clauses.length <= 1) return src.slice(0, MAX - 1) + '…';

  // 分词：英文/数字整词 + 非停用词的中文二元组
  const tokenize = (str) => {
    const out = [];
    for (const w of (str.toLowerCase().match(/[a-z0-9]+/g) || [])) out.push(w);
    const cjk = str.replace(/[a-z0-9]+/gi, '').replace(/[^一-龥]/g, '');
    for (let i = 0; i + 1 < cjk.length; i++) {
      const bg = cjk.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bg) && !(STOP_CHARS.has(cjk[i]) && STOP_CHARS.has(cjk[i + 1]))) out.push(bg);
    }
    return out;
  };

  const freq = {};
  tokenize(src).forEach(k => { freq[k] = (freq[k] || 0) + 1; });

  // 逐句打分：内容密度（去重）+ 动作动词 + 时间 + 标题降权
  const scored = clauses.map((s, i) => {
    const toks = tokenize(s);
    if (!toks.length) return { s, i, score: -1 };
    const seen = new Set();
    let sum = 0, cnt = 0;
    toks.forEach(k => { if (!seen.has(k)) { seen.add(k); sum += freq[k] || 0; cnt++; } });
    let score = sum / Math.sqrt(cnt);
    for (const v of ACTION) { if (s.includes(v)) { score *= 1.6; break; } }
    if (/(\d+\s*[月日号点时分]|本周|下周|今天|明天|后天|早上|上午|中午|下午|晚上|晚间)/.test(s)) score *= 1.45;
    else if (/\d/.test(s)) score *= 1.1;
    if (/[#@【】]/.test(s) || /^(关于|通知)/.test(s)) score *= 0.45;
    if (s.length < 3) score *= 0.4;
    return { s, i, score };
  });

  // 清理句首连接词 / 主语助词前缀
  const clean = (s) => s
    .replace(/^(然后|所以|因此|于是|但是|可是|不过|而且|另外|总之|也就是说|就是说|其实|我觉得|我认为|我知道|请注意|请记得|请)/, '')
    .replace(/^(我|我们|你|您|他|她|他们|大家)/, '')
    .replace(/^(要记得|想记得|得记得|应该记得|必须记得|需要记得|要|想|得|应该|必须|需要|记得|别忘了|请注意)/, '')
    .trim();

  // 取最高分一条；太短则再补一条不重复的高分从句
  const ranked = scored.slice().sort((a, b) => b.score - a.score);
  const picks = [ranked[0]];
  if (ranked[0].s.length < 14 && ranked.length > 1) {
    const second = ranked.slice(1).find(x => !ranked[0].s.includes(x.s) && !x.s.includes(ranked[0].s));
    if (second) picks.push(second);
  }
  picks.sort((a, b) => a.i - b.i);

  let out = picks.map(x => clean(x.s)).filter(Boolean).join('，');
  if (!out) out = src.slice(0, MAX - 1) + '…';
  else if (out.length > MAX) {
    let cut = out.slice(0, MAX);
    const sp = cut.lastIndexOf(' ');
    if (sp > MAX * 0.4) cut = cut.slice(0, sp);   // 优先在空格处断开，避免截断到词中间
    out = cut.replace(/[，,、；;。\s]+$/, '') + '…';
  }
  return out;
}

async function summarizeSelected() {
  const text = await captureSelection();
  if (!text) {
    const msg = '未捕捉到文字，请先选中一段文字（或先复制）';
    notifyRenderer('summarize-error', msg);
    if (Notification.isSupported()) new Notification({ title: '待办清单总结', body: msg }).show();
    return;
  }
  const ai = getAIConfig();
  const mode = ai.mode || 'auto';
  if (mode !== 'auto' && !ai.apiKey) {
    const msg = '未配置 API Key，请在设置中填写';
    notifyRenderer('summarize-error', msg);
    if (Notification.isSupported()) new Notification({ title: '待办清单总结', body: msg }).show();
    return;
  }
  const d = new Date();
  const capturedAt = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  notifyRenderer('summarize-start');
  try {
    let summary, offline = false;
    if (mode !== 'auto') {
      summary = await callLLM(ai, text);
    } else {
      if (ai.apiKey) {
        try { summary = await callLLM(ai, text); }
        catch { summary = summarizeOffline(text); offline = true; }
      } else {
        summary = summarizeOffline(text);
        offline = true;
      }
    }
    notifyRenderer('summarize-result', { summary, capturedAt, originalLen: text.length, offline });
    if (Notification.isSupported()) {
      new Notification({ title: offline ? '已离线总结并加入待办' : '已总结并加入待办', body: summary }).show();
    }
  } catch (err) {
    const msg = '总结失败：' + (err && err.message ? err.message : err);
    notifyRenderer('summarize-error', msg);
    if (Notification.isSupported()) new Notification({ title: '待办清单总结', body: msg }).show();
  }
}

// ---------- 窗口 ----------
function createMainWindow(show = true) {
  mainWin = new BrowserWindow({
    width: 640,
    height: 800,
    minWidth: 420,
    minHeight: 560,
    title: '待办清单',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    show,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWin.loadFile('index.html');

  // 关闭时隐藏到托盘，不退出
  mainWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => {
    mainWin = null;
  });
  mainWin.on('maximize', () => { if (mainWin) mainWin.webContents.send('window-maximized', true); });
  mainWin.on('unmaximize', () => { if (mainWin) mainWin.webContents.send('window-maximized', false); });
}

function showMain() {
  if (!mainWin) {
    createMainWindow();
    return;
  }
  mainWin.show();
  mainWin.focus();
}

function createWidgetWindow() {
  if (widgetWin) {
    widgetWin.show();
    widgetWin.focus();
    return;
  }

  const opts = {
    width: 320,
    height: 480,
    minWidth: 260,
    minHeight: 240,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    title: '待办清单 · 桌贴',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  // 还原上次关闭时的位置（越界则回退默认居中）
  const savedPos = loadConfig().widgetPos;
  const pos = savedPos && clampWidgetPos(savedPos.x, savedPos.y);
  if (pos) { opts.x = pos.x; opts.y = pos.y; }

  widgetWin = new BrowserWindow(opts);

  widgetWin.loadFile('index.html', { query: { widget: '1' } });
  widgetWin.setIgnoreMouseEvents(!!loadConfig().widgetClickThrough, { forward: true });
  widgetWin.webContents.on('did-finish-load', () => sendWidgetState());
  // 拖动过程中防抖保存位置，避免频繁写盘
  let posTimer = null;
  widgetWin.on('moved', () => {
    clearTimeout(posTimer);
    posTimer = setTimeout(saveWidgetPos, 400);
  });
  widgetWin.on('close', () => saveWidgetPos());
  widgetWin.on('closed', () => {
    widgetWin = null;
  });
}

function toggleWidget() {
  if (widgetWin) {
    widgetWin.close();
  } else {
    createWidgetWindow();
  }
}

function sendWidgetState() {
  if (widgetWin) {
    widgetWin.webContents.send('widget-state', {
      pinned: widgetWin.isAlwaysOnTop(),
      clickThrough: !!loadConfig().widgetClickThrough,
    });
  }
}

// ---------- 托盘 ----------
function getTrayIconPath() {
  // 把图标复制到 userData，避免从 asar 里读取托盘图标失败
  const dest = path.join(app.getPath('userData'), 'tray-icon.ico');
  try {
    const buf = fs.readFileSync(path.join(__dirname, 'icon.ico'));
    if (buf && buf.length) {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(dest, buf);
      return dest;
    }
  } catch {}
  return path.join(__dirname, 'icon.ico');
}

function createTray() {
  const icon = nativeImage.createFromPath(getTrayIconPath());
  tray = new Tray(icon);
  tray.setToolTip('待办清单');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开待办清单', click: () => showMain() },
    { label: '显示 / 隐藏桌贴', click: () => toggleWidget() },
    { label: '总结选中文字', click: () => summarizeSelected() },
    {
      type: 'checkbox',
      label: '桌贴穿透点击',
      checked: !!loadConfig().widgetClickThrough,
      click: (item) => setWidgetClickThrough(item.checked),
    },
    { type: 'separator' },
    {
      type: 'checkbox',
      label: '开机自动打开桌贴',
      checked: !!loadConfig().autoOpenWidget,
      click: (item) => setAutoOpenWidget(item.checked),
    },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showMain());
}

Menu.setApplicationMenu(null);

// ---------- IPC ----------
ipcMain.on('toggle-widget', () => toggleWidget());
ipcMain.on('widget-close', () => { if (widgetWin) widgetWin.close(); });
ipcMain.on('widget-toggle-pin', () => {
  if (!widgetWin) return;
  widgetWin.setAlwaysOnTop(!widgetWin.isAlwaysOnTop());
  sendWidgetState();
});
ipcMain.on('widget-set-locked', (_e, locked) => {
  if (!widgetWin) return;
  widgetWin.setResizable(!locked);
});
ipcMain.on('widget-open-main', () => showMain());
ipcMain.on('window-minimize', () => { if (mainWin) mainWin.minimize(); });
ipcMain.on('window-toggle-maximize', () => {
  if (!mainWin) return;
  if (mainWin.isMaximized()) mainWin.unmaximize();
  else mainWin.maximize();
});
ipcMain.on('window-close', () => { if (mainWin) mainWin.close(); });
ipcMain.handle('get-ai-config', () => getAIConfig());
ipcMain.on('set-ai-config', (_e, cfg) => saveAIConfig(cfg));
ipcMain.handle('get-auto-open-widget', () => !!loadConfig().autoOpenWidget);
ipcMain.on('set-auto-open-widget', (_e, enabled) => setAutoOpenWidget(enabled));
ipcMain.on('set-theme', (_e, theme) => {
  // 同步 Electron 原生主题：原生 <select> 下拉弹层/日期控件在 Windows 上是原生绘制，只靠 CSS color-scheme 不会变深色
  if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme;
});
ipcMain.on('notify', (_e, { title, body }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title || '待办清单', body: body || '' });
  n.on('click', () => showMain());
  n.show();
});

// Server酱微信推送（Turbo 版）：SendKey 从 sct.ftqq.com 微信扫码获取，形如 SCTxxxx
async function scPush(key, title, desp) {
  const url = 'https://sctapi.ftqq.com/' + encodeURIComponent(String(key).trim()) + '.send';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, desp }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json().catch(() => null);
  if (!j || j.code !== 0) throw new Error('Server酱返回 ' + (j && j.message ? j.message : '异常'));
  return true;
}
ipcMain.on('sc-push', (_e, { key, title, body }) => {
  if (!key) return;
  scPush(key, title, body).catch((e) => console.error('Server酱推送失败:', e && e.message ? e.message : e));
});

// 单实例：再次启动时只浮现已有主窗口
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMain();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    saveWidgetPos();
  });

  app.whenReady().then(() => {
    const cfg = loadConfig();
    // 保持登录项与配置一致
    app.setLoginItemSettings({ openAtLogin: !!cfg.autoOpenWidget, args: ['--autostart'] });

    // 开机自启时：只显示桌贴，主窗口留在托盘
    const isAutostart = !!cfg.autoOpenWidget && process.argv.includes('--autostart');
    createMainWindow(!isAutostart);
    createTray();
    globalShortcut.register('CommandOrControl+Shift+S', () => { summarizeSelected(); });
    if (isAutostart) {
      createWidgetWindow();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

// 不随窗口关闭退出：应用常驻托盘
app.on('window-all-closed', () => {
  // 保持运行，通过托盘菜单退出
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
