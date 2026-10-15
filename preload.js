const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  toggleWidget: () => ipcRenderer.send('toggle-widget'),
  widgetClose: () => ipcRenderer.send('widget-close'),
  widgetTogglePin: () => ipcRenderer.send('widget-toggle-pin'),
  widgetSetLocked: (v) => ipcRenderer.send('widget-set-locked', v),
  widgetOpenMain: () => ipcRenderer.send('widget-open-main'),
  onWidgetState: (cb) => ipcRenderer.on('widget-state', (_e, s) => cb(s)),
  minimize: () => ipcRenderer.send('window-minimize'),
  toggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
  close: () => ipcRenderer.send('window-close'),
  onMaximizeChange: (cb) => ipcRenderer.on('window-maximized', (_e, v) => cb(v)),
  getAIConfig: () => ipcRenderer.invoke('get-ai-config'),
  setAIConfig: (cfg) => ipcRenderer.send('set-ai-config', cfg),
  getAutoOpenWidget: () => ipcRenderer.invoke('get-auto-open-widget'),
  setAutoOpenWidget: (v) => ipcRenderer.send('set-auto-open-widget', v),
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),
  onSummarizeStart: (cb) => ipcRenderer.on('summarize-start', () => cb()),
  onSummarizeResult: (cb) => ipcRenderer.on('summarize-result', (_e, r) => cb(r)),
  onSummarizeError: (cb) => ipcRenderer.on('summarize-error', (_e, msg) => cb(msg)),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  scPush: (key, title, body) => ipcRenderer.send('sc-push', { key, title, body }),
});
