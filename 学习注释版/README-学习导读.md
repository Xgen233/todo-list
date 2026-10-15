# 待办清单 · 源码学习导读

这是一份「给学习者」的导读，帮你理解整个 Electron 应用是怎么搭起来的。
代码本体在旁边的 `main.js` / `preload.js` / `index.html` / `package.json` 里，都已逐行加注释。
建议按本导读的顺序阅读。

---

## 一、Electron 的三个进程（最重要的一张图）

Electron 应用不是「一个 JS 文件跑到底」，而是被切成三个角色，各跑各的：

```
┌─────────────────────────────────────────────────────────────┐
│                        Electron 应用                          │
│                                                              │
│  ┌────────────────────┐        IPC         ┌──────────────┐  │
│  │    主进程 main.js    │ ◄──────────────► │  渲染进程      │  │
│  │  (Node.js 环境)      │   ipcMain /       │  index.html   │  │
│  │  能调系统 API：       │   ipcRenderer     │  (浏览器环境)  │  │
│  │  窗口/托盘/通知/     │                   │  能操作 DOM   │  │
│  │  剪贴板/快捷键/文件   │                   │  不能直接碰    │  │
│  │                     │                   │  系统/Node     │  │
│  └────────────────────┘                   └──────────────┘  │
│           ▲                                                    │
│           │ contextBridge（在 preload.js 里搭桥）               │
│           ▼                                                    │
│  ┌────────────────────┐                                        │
│  │  preload.js 预加载   │  唯一能同时摸到「Node」和「浏览器」的层  │
│  └────────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
```

| 进程 | 文件 | 运行环境 | 能做什么 / 不能做什么 |
|------|------|----------|----------------------|
| **主进程** | `main.js` | Node.js（有 `require('electron')`） | 创建窗口、托盘、系统通知、全局快捷键、读剪贴板、读写文件、发网络请求。**没有 DOM**，不能直接操作页面。 |
| **预加载** | `preload.js` | Node + 浏览器之间 | 用 `contextBridge` 把主进程的能力「打包成一个白名单对象」暴露给页面。 |
| **渲染进程** | `index.html` | 浏览器（Chromium） | 画界面、点按钮、存 localStorage。**默认摸不到 Node 和系统 API**（因为 `nodeIntegration: false` + `contextIsolation: true`）。 |

为什么要这么分？**安全**。如果让网页代码直接能 `require('fs')`，那网页里任何一个 XSS 漏洞都能读你硬盘。
所以 Electron 默认把渲染进程关进「浏览器笼子」，只通过 `preload.js` 里显式列出的那几个方法（白名单）跟主进程通信。

---

## 二、IPC：渲染进程 ↔ 主进程 怎么对话

渲染进程不能直接调主进程的函数，只能「发消息」。这套机制叫 **IPC（Inter-Process Communication，进程间通信）**。

本工程用了两种 IPC 风格，正好是 Electron 的两套标准：

### 1. 单向发送 `send` / `on`（发个消息，不关心返回值）

```js
// 渲染进程（preload.js 里封装）：
ipcRenderer.send('toggle-widget');            // 发一个「切换桌贴」的信号

// 主进程（main.js 里监听）：
ipcMain.on('toggle-widget', () => toggleWidget());   // 收到就干活
```
频道名（如 `'toggle-widget'`）就是约定好的「暗号」，两边要一致。

### 2. 请求-响应 `invoke` / `handle`（要拿到返回值）

```js
// 渲染进程：
const config = await window.api.getAIConfig();   // 想问主进程要数据

// 主进程：
ipcMain.handle('get-ai-config', () => getAIConfig());  // 返回的值会回传给渲染进程
```
凡是「渲染进程想从主进程拿数据」的场景（读配置、读状态），都用 `invoke/handle`。

> 反过来，主进程要主动推消息给渲染进程，用 `webContents.send`，对应渲染进程 `ipcRenderer.on` 接收。
> 比如 AI 总结完成后，主进程 `notifyRenderer('summarize-result', {...})`，页面 `onSummarizeResult` 就收到并刷新列表。

---

## 三、三个文件怎么串起来（读代码的路线）

**第 1 步：读 `package.json`**
看 `"main": "main.js"` —— Electron 启动时第一个跑的就是它。还有 `scripts`（怎么运行/打包）和 `build`（打包配置）。

**第 2 步：读 `main.js`（主进程，最重要）**
从底部 `app.whenReady()` 往上追：
- 创建主窗口 `createMainWindow()`（玻璃态、无边框、可拖）
- 创建桌贴窗口 `createWidgetWindow()`（透明、置顶、穿透点击）
- 创建托盘 `createTray()`
- 注册全局快捷键 `Ctrl+Shift+S`
- 下面一大排 `ipcMain.on/handle(...)` 是它对外提供的「接口」，对应 preload 里的每一个方法

**第 3 步：读 `preload.js`（最短，20 几行）**
它做的事情就一件：`contextBridge.exposeInMainWorld('api', {...})`，
把 `ipcRenderer` 的一堆 `send/invoke/on` 包成好用的 `window.api.xxx` 方法，暴露给页面。

**第 4 步：读 `index.html`（最长）**
- 顶部 `<style>`：CSS 变量做主题（浅/深两套色板）、玻璃拟态、动画、桌贴模式。
- 中间 `<body>`：主界面 + 桌贴 + 设置面板三块 DOM。
- 底部 `<script>`：真正的业务逻辑——数据模型、增删改、时间识别、分类、提醒、云端同步。
  渲染进程里所有 `window.api.xxx` 的调用，都会穿越 preload → IPC → 跑到 main.js 里执行。

---

## 四、本项目值得学的几个「点」

1. **无边框窗口 + 自定义标题栏**：`frame: false`，标题栏用 CSS `-webkit-app-region: drag` 让某块区域可拖动窗口。
2. **玻璃拟态（Acrylic）**：`backgroundMaterial: 'acrylic'` + CSS `backdrop-filter: blur(...)`。
3. **单实例 + 托盘常驻**：`app.requestSingleInstanceLock()`；关闭窗口不退出，藏进托盘。
4. **全局快捷键捕捉选中文字**：`Ctrl+Shift+S` → 主进程用 PowerShell `SendKeys('^c')` 模拟 Ctrl+C → 读剪贴板 → AI/本地总结。
5. **`contextIsolation` 安全桥**：渲染进程永远只看到 `window.api` 白名单，看不到 Node。
6. **同一套 `index.html` 复用成两个窗口**：主窗口 vs 桌贴，靠 URL 参数 `?widget=1` 区分，用 CSS 类切换显示哪套 UI。
7. **原生控件深色模式坑**：`<select>` 下拉弹层是 Windows 原生绘制，只改 CSS 不够，必须 `nativeTheme.themeSource`。
8. **中文自然语言时间解析**：`parseTime()` 能从「明天下午3点」「30分钟后」这种文字里抽出截止时间和提醒时间。
9. **云端同步（Gitee REST API）**：渲染进程直接 `fetch`，base64 编码 JSON 存到单个文件。
10. **纯 Node 手写 PNG/ICO 编码**：`gen-icon.js` 不依赖任何库，手写 CRC32 + PNG chunk + 有符号距离场画图标。

---

## 五、怎么运行 / 打包（备忘）

```bash
cd /d/待办清单
npm start                              # 开发运行（Electron）
# 打包安装包：
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run build
```
详细说明见项目根目录的《使用说明.md》。

---

## 六、建议阅读顺序总结

```
package.json  →  main.js（主进程）  →  preload.js  →  index.html（渲染进程）
                                                  ↘ gen-icon.js / serve-web.js / scriptable-widget.js（可选扩展）
```

祝学习顺利 🎉
