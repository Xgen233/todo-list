// ============================================================
// main.js —— Electron 主进程（整个应用的「大脑」）
// ============================================================
// 主进程运行在 Node.js 环境里，拥有操作系统级的权限：
//   创建窗口、托盘图标、系统通知、全局快捷键、读写剪贴板、读写文件、发网络请求。
// 它没有 DOM，不能直接改页面；页面（渲染进程）想让它干活，要通过 IPC 发消息，
// 下面一大排 ipcMain.on / ipcMain.handle 就是它对外提供的「接口」。

// require('electron') 拿到的是一堆 Electron 内置对象，逐个说明：
const { app,          // app：应用生命周期（何时就绪、何时退出）、获取系统路径
        BrowserWindow, // BrowserWindow：创建/管理窗口
        Menu,          // Menu：构建菜单（这里用来做托盘右键菜单）
        ipcMain,       // ipcMain：主进程侧接收渲染进程 IPC 消息
        Tray,          // Tray：系统托盘图标
        nativeImage,   // nativeImage：加载本地图片为图标
        nativeTheme,   // nativeTheme：控制系统级深浅色（影响原生控件外观）
        globalShortcut,// globalShortcut：注册全局快捷键（不限于应用窗口内）
        clipboard,     // clipboard：读写系统剪贴板
        Notification,  // Notification：发系统通知（右下角弹窗）
        screen } = require('electron'); // screen：查询显示器信息（多屏坐标校验用）
const path = require('path');   // 拼文件路径
const fs = require('fs');       // 读写文件
const { execFile } = require('child_process'); // 执行外部程序（这里用来跑 PowerShell 模拟 Ctrl+C）

// ---- 顶层变量：保存窗口/托盘的引用，供各函数共享 ----
let mainWin = null;     // 主窗口
let widgetWin = null;   // 桌贴小窗口
let tray = null;        // 托盘图标
let isQuitting = false; // 标记「用户点了退出」，用于区分「关闭窗口」和「真正退出」

// ---------- 配置（持久化到 userData/config.json） ----------
// app.getPath('userData') 是每个应用专属的配置目录（Windows 上是 %APPDATA%\todo-list），
// 这里的 config.json 存的是「主进程才关心的」配置（AI key、桌贴位置、开机自启等），
// 与渲染进程里的 localStorage 是两套存储，各管各的。

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// 读配置：文件不存在或 JSON 坏了就返回空对象（容错，不让程序崩）
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

// 存配置：先确保目录存在，再写文件（缩进 2 空格方便人看）
function saveConfig(cfg) {
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); } catch {}
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

// 开机自启桌贴：改配置 + 改系统「登录项」注册表
function setAutoOpenWidget(enabled) {
  const cfg = loadConfig();
  cfg.autoOpenWidget = !!enabled;   // !! 把任何值转成布尔
  saveConfig(cfg);
  // app.setLoginItemSettings 设置「登录时自动启动」。
  // args:['--autostart'] 让应用启动时能识别「这次是开机自启」，从而只弹桌贴、不弹主窗口。
  // 注意：这招只对「打包安装后的 exe」生效，开发态 npm start 无效。
  app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--autostart'] });
}

// 桌贴「穿透点击」：开启后鼠标能直接点到桌贴下面的东西（桌贴变成纯展示）
function setWidgetClickThrough(enabled) {
  const cfg = loadConfig();
  cfg.widgetClickThrough = !!enabled;
  saveConfig(cfg);
  // setIgnoreMouseEvents(true) 让窗口忽略鼠标；{ forward: true } 表示鼠标事件「穿透」给下层窗口
  if (widgetWin) widgetWin.setIgnoreMouseEvents(!!enabled, { forward: true });
  sendWidgetState(); // 通知桌贴界面更新状态显示
}

// 校验保存的桌贴坐标是否仍落在某个显示器工作区内
// （换显示器 / 改分辨率后，原来记住的坐标可能跑到屏幕外，需要兜底）
function clampWidgetPos(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (const d of screen.getAllDisplays()) {   // 遍历所有显示器
    const wa = d.workArea;                     // 该显示器的可用工作区（排除任务栏）
    // 坐标落在某个工作区内 → 合法，返回原坐标
    if (x >= wa.x && x < wa.x + wa.width && y >= wa.y && y < wa.y + wa.height) {
      return { x, y };
    }
  }
  return null;   // 全都越界 → 返回 null，让创建窗口时回退到默认居中
}

// 保存桌贴窗口当前位置，重开时还原
function saveWidgetPos() {
  if (!widgetWin || widgetWin.isDestroyed()) return;   // 窗口已销毁则跳过
  const [x, y] = widgetWin.getPosition();              // 拿到当前窗口坐标
  const cfg = loadConfig();
  cfg.widgetPos = { x, y };
  saveConfig(cfg);
}

// ---------- AI 总结 ----------
// AI 配置存 config.json 的 ai 字段；有默认值兜底（DeepSeek 官方接口 + deepseek-chat 模型）
function getAIConfig() {
  const cfg = loadConfig().ai || {};
  return {
    apiKey: cfg.apiKey || '',
    baseURL: cfg.baseURL || 'https://api.deepseek.com',
    model: cfg.model || 'deepseek-chat',
    mode: cfg.mode || 'auto',   // auto = 有 key 用 AI，否则本地规则；ai = 强制 AI
  };
}

function saveAIConfig(ai) {
  // Object.assign 合并：保留其它字段，只覆盖 ai 字段
  saveConfig(Object.assign({}, loadConfig(), { ai }));
}

// 用 PowerShell 模拟按下 Ctrl+C：
// 因为「总结选中文字」时，应用不在前台，无法用 JS 拿选中内容，
// 所以退而求其次：模拟系统级 Ctrl+C，把选中文字复制进剪贴板，再去读剪贴板。
function simulateCopy() {
  return new Promise((resolve) => {
    // $w.SendKeys('^c') = 发送 Ctrl+C 按键；Start-Sleep 等 250ms 让复制完成
    const ps = `$w = New-Object -ComObject WScript.Shell; $w.SendKeys('^c'); Start-Sleep -Milliseconds 250`;
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, () => resolve());
  });
}

// 捕捉当前选中的文字：模拟 Ctrl+C → 等 120ms → 读剪贴板
async function captureSelection() {
  await simulateCopy();
  await new Promise((r) => setTimeout(r, 120));
  return clipboard.readText().trim();
}

// 主动推送消息给主窗口（渲染进程用 ipcRenderer.on 接收）
function notifyRenderer(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

// 调大模型总结：DeepSeek 是 OpenAI 兼容接口，直接 POST 到 /chat/completions
async function callLLM(ai, text) {
  // 去掉末尾斜杠再拼路径，避免出现 //chat/completions
  const url = ai.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ai.apiKey },
    body: JSON.stringify({
      model: ai.model,
      // 系统提示词：规定角色和输出格式（简短待办、不超过30字、只要结果）
      messages: [
        { role: 'system', content: '你是待办事项总结助手。把用户提供的文字总结成一条简短待办事项（不超过30字），直接输出总结内容，不要任何解释、前缀或引号。' },
        { role: 'user', content: text.slice(0, 4000) },  // 截断到 4000 字，防超长
      ],
      temperature: 0.3,   // 温度低 = 输出更稳定保守
      max_tokens: 120,    // 限制输出长度
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + (t ? ' ' + t.slice(0, 160) : ''));
  }
  const data = await res.json();
  // 一路安全地取到 content，避免字段缺失时报错
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('返回内容为空');
  // 去掉首尾可能带上的引号（大模型偶尔会包一层引号）
  return content.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
}

// 中文停用字/词：过滤掉虚词，避免词频被「的/了/是/我」等污染
// （本地规则总结会统计词频，虚词词频高但没意义，要剔除）
const STOP_CHARS = new Set('的一是在有和与或及也都就还而但若如因所以此等之其中又更最很太过于吗呢吧啊呀哦么着把被让给向从对到为去来上下前后里外这那哪个些什么怎么怎样如何为什么没有不是不会可以应该需要能够可能已经正在将要是否');
const STOP_BIGRAMS = new Set(['因为','所以','但是','如果','然后','而且','或者','以及','就是','不是','没有','可以','应该','需要','已经','正在','将要','这个','那个','这些','那些','什么','怎么','如何','为什么','由于','关于','对于','通过','根据','虽然','即使','尽管','不过','然而','因此','于是','接着','首先','其次','最后','另外','总之','例如','比如','就是说','尤其','特别','时候','东西','事情','问题','方面','情况']);
// 常见待办动作动词：含其中一个的从句更可能是「要做的事」，得分加权
const ACTION = new Set(['买','做','写','发','送','订','约','交','修','改','整理','收拾','打扫','取','拿','寄','付','报名','申请','预约','核对','检查','跟进','回复','沟通','汇报','培训','面试','出差','拜访','购买','下载','安装','升级','备份','打印','扫描','签字','盖章','报销','付款','转账','准备','完成','提交','更新','处理','联系','确认','安排','参加','开会','提醒','学习','复习','读','换','补','办理','补办','收集','汇总','填写','发放','领取','参会','预留','举行','组织','注册','报到','签到','布置','上交','递交','缴费']);

// 本地规则总结（不联网）：从一段文字里挑出「最有待办味」的一句话
function summarizeOffline(text) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  const MAX = 40;   // 总结最长 40 字
  if (src.length <= MAX) return src;   // 本身就很短，直接用

  // 按标点切从句（逗号、句号、感叹号等）
  const clauses = src.split(/[，,、。！？!?；;]+/).map(s => s.trim()).filter(Boolean);
  if (clauses.length <= 1) return src.slice(0, MAX - 1) + '…';  // 只有一句，截断

  // 分词：英文/数字整词 + 非停用词的中文二元组（两两相邻的字）
  const tokenize = (str) => {
    const out = [];
    for (const w of (str.toLowerCase().match(/[a-z0-9]+/g) || [])) out.push(w);  // 英文/数字整词
    const cjk = str.replace(/[a-z0-9]+/gi, '').replace(/[^一-龥]/g, '');          // 只留汉字
    for (let i = 0; i + 1 < cjk.length; i++) {
      const bg = cjk.slice(i, i + 2);   // 取相邻两字组成二元组
      // 跳过停用二元组，也跳过「两个都是停用字」的组合
      if (!STOP_BIGRAMS.has(bg) && !(STOP_CHARS.has(cjk[i]) && STOP_CHARS.has(cjk[i + 1]))) out.push(bg);
    }
    return out;
  };

  const freq = {};
  tokenize(src).forEach(k => { freq[k] = (freq[k] || 0) + 1; });   // 统计词频

  // 逐句打分：内容密度（去重）+ 动作动词 + 时间 + 标题降权
  const scored = clauses.map((s, i) => {
    const toks = tokenize(s);
    if (!toks.length) return { s, i, score: -1 };
    const seen = new Set();
    let sum = 0, cnt = 0;
    toks.forEach(k => { if (!seen.has(k)) { seen.add(k); sum += freq[k] || 0; cnt++; } }); // 去重后按词频求和
    let score = sum / Math.sqrt(cnt);   // 除以根号数量，抑制「字多分就高」的偏差
    for (const v of ACTION) { if (s.includes(v)) { score *= 1.6; break; } }   // 有动作动词 → 加权
    if (/(\d+\s*[月日号点时分]|本周|下周|今天|明天|后天|早上|上午|中午|下午|晚上|晚间)/.test(s)) score *= 1.45;  // 有时间 → 加权
    else if (/\d/.test(s)) score *= 1.1;
    if (/[#@【】]/.test(s) || /^(关于|通知)/.test(s)) score *= 0.45;   // 像标题/通知 → 降权
    if (s.length < 3) score *= 0.4;   // 太短 → 降权
    return { s, i, score };
  });

  // 清理句首连接词 / 主语助词前缀（让结果更干净）
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
  picks.sort((a, b) => a.i - b.i);   // 按原文顺序排列

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

// 「总结选中文字」主流程（托盘菜单 / 全局快捷键都会触发它）
async function summarizeSelected() {
  const text = await captureSelection();   // 拿选中文字
  if (!text) {
    const msg = '未捕捉到文字，请先选中一段文字（或先复制）';
    notifyRenderer('summarize-error', msg);
    if (Notification.isSupported()) new Notification({ title: '待办清单总结', body: msg }).show();
    return;
  }
  const ai = getAIConfig();
  const mode = ai.mode || 'auto';
  // 强制 AI 模式但没配 key → 报错
  if (mode !== 'auto' && !ai.apiKey) {
    const msg = '未配置 API Key，请在设置中填写';
    notifyRenderer('summarize-error', msg);
    if (Notification.isSupported()) new Notification({ title: '待办清单总结', body: msg }).show();
    return;
  }
  const d = new Date();
  const capturedAt = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');  // 记录「几点几分总结的」
  notifyRenderer('summarize-start');
  try {
    let summary, offline = false;
    if (mode !== 'auto') {
      // 强制 AI 模式
      summary = await callLLM(ai, text);
    } else {
      // auto 模式：有 key 就试 AI，失败或没 key 就本地规则兜底
      if (ai.apiKey) {
        try { summary = await callLLM(ai, text); }
        catch { summary = summarizeOffline(text); offline = true; }
      } else {
        summary = summarizeOffline(text);
        offline = true;
      }
    }
    // 把结果推给渲染进程（它会 addSummarizedItem 加入列表）
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
// 创建主窗口
function createMainWindow(show = true) {
  mainWin = new BrowserWindow({
    width: 640, height: 800,          // 初始尺寸
    minWidth: 420, minHeight: 560,    // 最小尺寸
    title: '待办清单',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,            // 隐藏默认菜单栏
    frame: false,                     // ★ 无边框窗口（标题栏由网页自己画，可拖动）
    backgroundColor: '#00000000',     // 全透明背景色（配合玻璃拟态）
    backgroundMaterial: 'acrylic',    // ★ Windows 亚克力/毛玻璃效果（Win11 才有视觉）
    show,                             // 是否立即显示
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),  // 预加载脚本路径
      contextIsolation: true,          // ★ 隔离：渲染进程拿不到 Node，安全
      nodeIntegration: false,          // ★ 禁止渲染进程直接用 Node
      backgroundThrottling: false,     // ★ 关闭后台节流（否则窗口隐藏到托盘后 setInterval 被降频，提醒会晚）
    },
  });

  mainWin.loadFile('index.html');   // 加载页面（同一份 index.html，主窗口不带参数）

  // 「关闭」事件：拦截默认关闭行为，改成隐藏到托盘（不退出）
  mainWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();   // 阻止真的关闭
      mainWin.hide();       // 只是隐藏
    }
  });
  mainWin.on('closed', () => { mainWin = null; });
  // 把「是否最大化」状态同步给渲染进程（用来切换 □/❐ 按钮图标）
  mainWin.on('maximize', () => { if (mainWin) mainWin.webContents.send('window-maximized', true); });
  mainWin.on('unmaximize', () => { if (mainWin) mainWin.webContents.send('window-maximized', false); });
}

// 显示主窗口（没有就新建，有就显示并聚焦）
function showMain() {
  if (!mainWin) { createMainWindow(); return; }
  mainWin.show();
  mainWin.focus();
}

// 创建桌贴小窗口（透明、置顶、可穿透点击的桌面便签）
function createWidgetWindow() {
  if (widgetWin) { widgetWin.show(); widgetWin.focus(); return; }

  const opts = {
    width: 320, height: 480,
    minWidth: 260, minHeight: 240,
    frame: false,          // 无边框
    transparent: true,     // ★ 窗口背景透明（桌贴是不规则/透明外观）
    resizable: true,
    alwaysOnTop: true,     // ★ 始终置顶（浮在其它窗口之上）
    skipTaskbar: true,     // 不显示在任务栏
    hasShadow: false,      // 去阴影
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

  // ★ 同一个 index.html，用 URL 参数 ?widget=1 区分「我是桌贴」
  widgetWin.loadFile('index.html', { query: { widget: '1' } });
  // 恢复「穿透点击」设置
  widgetWin.setIgnoreMouseEvents(!!loadConfig().widgetClickThrough, { forward: true });
  // 页面加载完，把桌贴状态（置顶/穿透）推过去
  widgetWin.webContents.on('did-finish-load', () => sendWidgetState());
  // 拖动过程中防抖保存位置，避免频繁写盘
  let posTimer = null;
  widgetWin.on('moved', () => {
    clearTimeout(posTimer);
    posTimer = setTimeout(saveWidgetPos, 400);   // 停下 400ms 才写盘
  });
  widgetWin.on('close', () => saveWidgetPos());
  widgetWin.on('closed', () => { widgetWin = null; });
}

// 切换桌贴显示/隐藏
function toggleWidget() {
  if (widgetWin) { widgetWin.close(); }
  else { createWidgetWindow(); }
}

// 把桌贴状态推送给桌贴窗口（置顶/穿透）
function sendWidgetState() {
  if (widgetWin) {
    widgetWin.webContents.send('widget-state', {
      pinned: widgetWin.isAlwaysOnTop(),
      clickThrough: !!loadConfig().widgetClickThrough,
    });
  }
}

// ---------- 托盘 ----------
// 托盘图标路径：把图标复制到 userData 下再读。
// 原因：打包后代码在 asar 压缩包内，直接读 asar 里的 ico 可能失败，复制出来更稳。
function getTrayIconPath() {
  const dest = path.join(app.getPath('userData'), 'tray-icon.ico');
  try {
    const buf = fs.readFileSync(path.join(__dirname, 'icon.ico'));
    if (buf && buf.length) {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(dest, buf);
      return dest;
    }
  } catch {}
  return path.join(__dirname, 'icon.ico');   // 复制失败就退回原路径
}

// 创建托盘图标 + 右键菜单
function createTray() {
  const icon = nativeImage.createFromPath(getTrayIconPath());
  tray = new Tray(icon);
  tray.setToolTip('待办清单');
  // 托盘右键菜单（Menu.buildFromTemplate 用数组描述菜单项）
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开待办清单', click: () => showMain() },
    { label: '显示 / 隐藏桌贴', click: () => toggleWidget() },
    { label: '总结选中文字', click: () => summarizeSelected() },   // 手动触发总结
    {
      type: 'checkbox',                                    // 勾选型菜单项
      label: '桌贴穿透点击',
      checked: !!loadConfig().widgetClickThrough,
      click: (item) => setWidgetClickThrough(item.checked),
    },
    { type: 'separator' },                                 // 分隔线
    {
      type: 'checkbox',
      label: '开机自动打开桌贴',
      checked: !!loadConfig().autoOpenWidget,
      click: (item) => setAutoOpenWidget(item.checked),
    },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },   // 真正退出
  ]));
  tray.on('click', () => showMain());   // 左键点托盘也打开主窗口
}

// 去掉应用默认菜单栏（无边框窗口本来也不需要）
Menu.setApplicationMenu(null);

// ---------- IPC ----------
// 下面这一大排是主进程对外提供的「接口」，一一对应 preload.js 里暴露的方法。
// send/invoke 的频道名必须和 preload.js 完全一致。

ipcMain.on('toggle-widget', () => toggleWidget());
ipcMain.on('widget-close', () => { if (widgetWin) widgetWin.close(); });
ipcMain.on('widget-toggle-pin', () => {
  if (!widgetWin) return;
  // 切换置顶：当前置顶就取消，否则置顶
  widgetWin.setAlwaysOnTop(!widgetWin.isAlwaysOnTop());
  sendWidgetState();
});
ipcMain.on('widget-set-locked', (_e, locked) => {
  if (!widgetWin) return;
  // 锁定后窗口不可调整大小（桌贴锁定态）
  widgetWin.setResizable(!locked);
});
ipcMain.on('widget-open-main', () => showMain());
ipcMain.on('window-minimize', () => { if (mainWin) mainWin.minimize(); });
ipcMain.on('window-toggle-maximize', () => {
  if (!mainWin) return;
  if (mainWin.isMaximized()) mainWin.unmaximize();
  else mainWin.maximize();
});
ipcMain.on('window-close', () => { if (mainWin) mainWin.close(); });   // 触发 close 事件 → 藏托盘

// AI 配置：invoke/handle 是「请求-响应」模式，能拿返回值
ipcMain.handle('get-ai-config', () => getAIConfig());
ipcMain.on('set-ai-config', (_e, cfg) => saveAIConfig(cfg));

ipcMain.handle('get-auto-open-widget', () => !!loadConfig().autoOpenWidget);
ipcMain.on('set-auto-open-widget', (_e, enabled) => setAutoOpenWidget(enabled));

ipcMain.on('set-theme', (_e, theme) => {
  // ★ 同步 Electron 原生主题：原生 <select> 下拉弹层/日期控件在 Windows 上是原生绘制，
  //   只靠 CSS 的 color-scheme 不会变深色，必须让 nativeTheme 也跟着变。
  if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme;
});

// 系统通知（渲染进程请求发通知，比如待办到点提醒）
ipcMain.on('notify', (_e, { title, body }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title || '待办清单', body: body || '' });
  n.on('click', () => showMain());   // 点通知回主窗口
  n.show();
});

// Server酱微信推送（Turbo 版）：
// SendKey 从 sct.ftqq.com 微信扫码获取，形如 SCTxxxx。
// 作用：待办到点时，除了系统通知，还推一条微信消息到手机。
async function scPush(key, title, desp) {
  const url = 'https://sctapi.ftqq.com/' + encodeURIComponent(String(key).trim()) + '.send';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, desp }),   // title=标题, desp=正文
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json().catch(() => null);
  if (!j || j.code !== 0) throw new Error('Server酱返回 ' + (j && j.message ? j.message : '异常'));  // code 0 才是成功
  return true;
}
ipcMain.on('sc-push', (_e, { key, title, body }) => {
  if (!key) return;   // 没配 SendKey 就不发
  scPush(key, title, body).catch((e) => console.error('Server酱推送失败:', e && e.message ? e.message : e));
});

// ---------- 单实例 ----------
// 应用只允许开一个实例：再启动时，不重复开新窗口，而是把已有主窗口浮现出来
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();   // 已有实例在跑，直接退出自己
} else {
  app.on('second-instance', () => {
    showMain();   // 有人二次启动时，把主窗口显示出来
  });

  app.on('before-quit', () => {
    isQuitting = true;   // 标记「真的要退了」，让 close 事件放行
    saveWidgetPos();     // 退出前保存桌贴位置
  });

  // app.whenReady()：Electron 就绪后才能建窗口，这是标准启动入口
  app.whenReady().then(() => {
    const cfg = loadConfig();
    // 保持系统「登录项」和配置里的 autoOpenWidget 一致
    app.setLoginItemSettings({ openAtLogin: !!cfg.autoOpenWidget, args: ['--autostart'] });

    // 判断这次是不是「开机自启」：配置开了自启，且命令行带了 --autostart 参数
    const isAutostart = !!cfg.autoOpenWidget && process.argv.includes('--autostart');
    createMainWindow(!isAutostart);   // 自启时主窗口先不显示（藏托盘）
    createTray();
    // 注册全局快捷键 Ctrl+Shift+S → 总结选中文字
    globalShortcut.register('CommandOrControl+Shift+S', () => { summarizeSelected(); });
    if (isAutostart) {
      createWidgetWindow();   // 自启时只弹桌贴
    }

    // macOS 的「点 Dock 图标激活」：所有窗口都关了再点 Dock 时重建主窗口
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

// 不随窗口关闭退出：所有窗口都关掉时也不退出，应用常驻托盘
app.on('window-all-closed', () => {
  // 保持运行，通过托盘菜单退出（这里故意留空）
});

// 退出前清理全局快捷键
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
