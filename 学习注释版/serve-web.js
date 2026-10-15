// ============================================================
// serve-web.js —— 局域网网页版服务器（零账号、零托管）
// ============================================================
// 作用：把 web-todo.html（网页版待办）通过局域网 HTTP 提供给 iPhone 访问。
// 原理：起一个极简 HTTP 服务器，监听本机所有网卡的某端口；
//      手机连同一 WiFi，用浏览器打开「电脑局域网 IP:端口」即可访问。
//
// 用法：在项目目录运行  node serve-web.js   （或双击 启动网页版.bat）
//       iPhone 连同一 WiFi，打开下面打印出的网址。

const http = require('http');   // Node 内置 HTTP 服务器模块
const fs = require('fs');       // 读文件
const path = require('path');   // 拼路径
const os = require('os');       // 获取网络接口信息（找局域网 IP）

const PORT = Number(process.env.PORT) || 8080;              // 端口：可被环境变量覆盖，默认 8080
const FILE = path.join(__dirname, 'web-todo.html');         // 要提供的网页文件

// 收集本机所有「局域网 IPv4」地址（排除 127.0.0.1 这类回环地址）
function lanIPs() {
  const ips = [];
  const nets = os.networkInterfaces();                       // 返回 { 网卡名: [地址对象...] }
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address); // IPv4 且非内部回环
    }
  }
  return ips;
}

// 创建 HTTP 服务器：每个请求都进这个回调
const server = http.createServer((req, res) => {
  // 只认三个路径（/ 、/index.html 、/web-todo.html），都返回同一个网页文件
  if (req.url === '/' || req.url === '/index.html' || req.url === '/web-todo.html') {
    fs.readFile(FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('读取 web-todo.html 失败');
        return;
      }
      // 明确告诉浏览器这是 UTF-8 的 HTML，否则中文可能乱码
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

// 监听 0.0.0.0：对所有网卡开放（局域网其它设备才能连进来）
server.listen(PORT, '0.0.0.0', () => {
  console.log('待办清单 · 网页版已启动（端口 ' + PORT + '）');
  const ips = lanIPs();
  if (ips.length) {
    ips.forEach((ip) => console.log('  iPhone 访问： http://' + ip + ':' + PORT));
  } else {
    console.log('  未检测到局域网 IP，请确认电脑已连 WiFi/网线');
  }
  console.log('按 Ctrl+C 停止。首次运行若 Windows 防火墙弹窗，请点「允许访问」。');
});
