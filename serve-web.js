// 把 web-todo.html 通过局域网提供给 iPhone 访问（零账号、零托管）
// 用法：在项目目录运行  node serve-web.js   （或双击 启动网页版.bat）
// 然后 iPhone 连同一 WiFi，用浏览器打开下面打印出的网址
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const FILE = path.join(__dirname, 'web-todo.html');

function lanIPs() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html' || req.url === '/web-todo.html') {
    fs.readFile(FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('读取 web-todo.html 失败');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

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
