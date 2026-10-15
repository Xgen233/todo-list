// ============================================================
// preload.js —— 预加载脚本（主进程与渲染进程之间的「安全桥梁」）
// ============================================================
// 作用：这是唯一能同时接触到「Node/Electron」和「浏览器 window」的一层。
// 它把主进程的能力「精选打包」成一个 window.api 对象暴露给页面，
// 页面（index.html）只能通过 window.api 里列出的这些方法与主进程通信，
// 无法直接 require('fs') 之类，保证安全。
//
// 关键点：contextBridge.exposeInMainWorld(名字, 对象)
//   → 在页面全局挂一个「名字」为 'api' 的对象，值就是第二个参数。
//   → 页面里用 window.api.xxx 调用。
//
// 下面每个方法本质上都是「转发」：把页面调用翻译成一条 IPC 消息发给主进程。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ---- 桌贴窗口控制（单向 send，主进程 ipcMain.on 接收）----
  toggleWidget: () => ipcRenderer.send('toggle-widget'),        // 打开/关闭桌贴
  widgetClose: () => ipcRenderer.send('widget-close'),          // 关闭桌贴
  widgetTogglePin: () => ipcRenderer.send('widget-toggle-pin'), // 桌贴置顶开关
  widgetSetLocked: (v) => ipcRenderer.send('widget-set-locked', v), // 桌贴锁定（锁定后不可调整大小）
  widgetOpenMain: () => ipcRenderer.send('widget-open-main'),   // 从桌贴打开主窗口

  // ---- 主窗口控制 ----
  minimize: () => ipcRenderer.send('window-minimize'),          // 最小化
  toggleMaximize: () => ipcRenderer.send('window-toggle-maximize'), // 最大化/还原
  close: () => ipcRenderer.send('window-close'),                // 关闭（主进程会藏到托盘）

  // ---- 订阅主进程的「推送」消息 ----
  // 主进程用 webContents.send('widget-state', s) 主动推过来，这里 on 接收并回调
  onWidgetState: (cb) => ipcRenderer.on('widget-state', (_e, s) => cb(s)),
  // 主进程推「窗口是否已最大化」状态，页面据此切换按钮图标
  onMaximizeChange: (cb) => ipcRenderer.on('window-maximized', (_e, v) => cb(v)),

  // ---- AI 配置（invoke/handle 请求-响应，能拿到返回值）----
  getAIConfig: () => ipcRenderer.invoke('get-ai-config'),       // 读 AI 配置（返回对象）
  setAIConfig: (cfg) => ipcRenderer.send('set-ai-config', cfg), // 存 AI 配置

  // ---- 开机自启桌贴 ----
  getAutoOpenWidget: () => ipcRenderer.invoke('get-auto-open-widget'), // 读开关状态
  setAutoOpenWidget: (v) => ipcRenderer.send('set-auto-open-widget', v), // 设开关

  // ---- 主题（同步原生控件深色模式）----
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),

  // ---- AI 总结选中文字的事件流 ----
  onSummarizeStart: (cb) => ipcRenderer.on('summarize-start', () => cb()),       // 开始总结
  onSummarizeResult: (cb) => ipcRenderer.on('summarize-result', (_e, r) => cb(r)), // 拿到总结结果
  onSummarizeError: (cb) => ipcRenderer.on('summarize-error', (_e, msg) => cb(msg)), // 出错

  // ---- 系统通知 ----
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),

  // ---- 微信提醒（Server酱）----
  scPush: (key, title, body) => ipcRenderer.send('sc-push', { key, title, body }),
});
