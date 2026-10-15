# 待办清单 · Todo List

一个简洁漂亮的 Windows 桌面待办事项应用（Electron）：玻璃拟态半透明主界面、桌面小组件「桌贴」、系统托盘常驻，支持分类管理、优先级、截止日期与定时提醒；还可以「选中任意文字 → AI 总结（DeepSeek）→ 一键存入待办」，并支持 Gitee 云端同步 + iOS Scriptable 小组件。

> 完整操作说明见 `使用说明.md`；想读懂源码请看 `学习注释版/README-学习导读.md`。

## 功能特性

- **玻璃拟态界面**：半透明卡片 + 磨砂，深色 / 浅色主题一键切换（自动记忆），透明度与磨砂强度可调。
- **桌面小组件（桌贴）**：置顶迷你清单，只显示未完成任务；支持快速添加、锁定防误删、穿透点击、位置记忆、开机自启。
- **系统托盘常驻**：点 × 不退出，收进托盘继续后台运行；托盘菜单可开关桌贴、触发总结、退出。
- **任务管理**：优先级（无 / 低 / 中 / 高）、自定义分类（名称 + 颜色）、截止日期、提醒时间、一键清除已完成。
- **定时提醒**：到点弹系统通知 + 应用内「灵动岛」气泡；支持按截止时间设置「提醒提前量」。
- **选中文字 AI 总结**：全局快捷键 `Ctrl + Shift + S`，自动复制选中文字并总结为 ≤30 字待办存入（可选 DeepSeek 大模型，未配置时自动回退本地总结）。
- **微信提醒（可选）**：填 Server酱 SendKey，提醒可推送到微信。
- **云端同步（可选）**：以 Gitee 私有仓库为后端，PC 端可上传 / 拉取 / 自动同步。
- **iPhone 小组件**：免费 App Scriptable + 仓库里的 `scriptable-widget.js`，桌面只读查看待办。
- **网页版**：单文件 `web/index.html`，可部署到任意静态托管（如 GitHub Pages）在手机浏览器查看。

## 技术栈

| 层 | 说明 |
|---|---|
| 桌面框架 | Electron 31 |
| 界面 | 原生 HTML / CSS / JavaScript，无框架、无构建步骤 |
| 数据 | 任务与显示设置存 localStorage；应用配置存 `%APPDATA%\todo-list\config.json` |
| AI | DeepSeek Chat API（OpenAI 兼容，可换其他兼容服务） |
| 云同步 | Gitee OpenAPI（私有仓库 + 私人令牌） |
| iOS 小组件 | Scriptable 脚本 |
| 打包 | electron-builder（NSIS 安装包） |

## 目录结构

```
待办清单/
├─ main.js               Electron 主进程：窗口 / 托盘 / 通知 / 全局快捷键 / 配置读写
├─ preload.js            预加载脚本：contextBridge 白名单 API
├─ index.html            主窗口界面（渲染进程，单文件含 CSS / JS）
├─ package.json          依赖与打包配置（electron-builder）
├─ gen-icon.js           生成应用图标的小工具（输出 icon.ico）
├─ icon.ico              应用图标
├─ serve-web.js          局域网服务器：把网页版发给手机访问
├─ 启动网页版.bat         双击运行上面的服务器
├─ scriptable-widget.js  iOS Scriptable 小组件脚本
├─ web/
│  └─ index.html         网页版（只读展示云端任务）
├─ 学习注释版/            逐行注释源码 + Electron 入门导读
└─ 使用说明.md            完整使用说明
```

## 快速开始

环境：Node.js 18+。国内网络建议先换 npm 镜像：

```bash
npm config set registry https://registry.npmmirror.com
```

```bash
# 安装依赖
npm install

# 开发运行（Electron 窗口直接打开）
npm start

# 打包 Windows 安装包（产物在 dist/）
npm run build
```

打包时若卡在下载 Electron 二进制，可用镜像加速：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run build
```

## 使用要点

### 主界面
- 顶部输入框输入任务，回车或点「添加」；添加前可设优先级 / 分类 / 截止日期 / 提醒时间。
- 点左侧圆圈完成（带对勾动画）；点彩色圆点循环切换优先级；点日期 / ⏰ 标签可清除；悬停任务点 × 删除。
- 顶部「全部 / 未完成 / 已完成」过滤，分类标签筛选；底部「清除已完成」一键清理。

### 桌贴（桌面小组件）
- 主界面右上角图钉开关桌贴，或托盘菜单「显示 / 隐藏桌贴」。
- 支持置顶、锁定、穿透点击、拖动与位置记忆；详细见 `使用说明.md` 第四节。

### 选中文字总结
1. 在任意应用里选中一段文字（网页 / Word / PDF / 记事本…）；
2. 按 `Ctrl + Shift + S`（或托盘菜单「总结选中文字」）；
3. 自动总结成一条待办并存入，右下角弹通知。

DeepSeek 配置：设置面板 →「总结」→ 填 API Key（在 platform.deepseek.com 申请），接口地址与模型保持默认即可。

### 云端同步 + iPhone 小组件
三步：Gitee 建私有仓库 → PC 设置面板填用户名 / 仓库名 / PAT → iPhone 安装 Scriptable 并粘贴 `scriptable-widget.js`。详见 `使用说明.md` 第十节。

## 数据与隐私

- 任务数据默认只在本机，不上传任何服务器。
- 「选中文字总结」仅在你启用 DeepSeek 时才会把文字发到你配置的接口；离线模式纯本地处理。
- 云端同步为可选项：数据存在你自己的 Gitee 私有仓库，令牌只保存在本机。

## 常见问题

| 现象 | 处理 |
|---|---|
| 按 Ctrl+Shift+S 提示「未捕捉到文字」 | 先选中文字再按快捷键；托盘菜单方式可能因焦点切换复制不到 |
| 提示「未配置 API Key」 | 设置里填 Key，或把总结方式切回「自动」 |
| 报 HTTP 401 / 404 | Key 失效，或接口地址 / 模型名填错 |
| 报 fetch failed / 超时 | 网络不通，检查网络与代理 |
| 想彻底退出程序 | 托盘右键 →「退出」（点 × 只是收进托盘） |

更多问答见 `使用说明.md` 第九节。

## 学习注释版

`学习注释版/` 目录是同一份源码的逐行注释副本 + 一份导读：Electron 主进程 / 预加载 / 渲染进程的分工、IPC（send/on 与 invoke/handle）、contextBridge 安全边界、托盘与无边框窗口实现等，适合作为 Electron 入门阅读材料。

## 许可

MIT（见 `package.json` 的 license 字段）。
