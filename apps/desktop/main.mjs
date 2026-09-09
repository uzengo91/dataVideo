/**
 * dataNews GUI 壳（Electron）：
 * - 启动内嵌的 dataVideo-server（pkg 单二进制，随包分发）
 * - 创建桌面窗口加载 http://127.0.0.1:<port>
 * - 关窗即退出（并终止服务进程）
 * 运行：npx electron apps/desktop/main.mjs（开发）
 * 打包：见 build/build-desktop.mjs（electron-builder）
 */
import { app, BrowserWindow, shell, dialog } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc = null;
let win = null;

// 资源定位：打包后 server 在 process.resourcesPath/bin/，开发时在仓库构建目录
function locateGsap() {
  const candidates = [
    path.join(process.resourcesPath ?? "", "templates", "gsap.min.js"),
    path.join(process.cwd(), "build", "assets", "templates", "gsap.min.js"),
    path.join(process.cwd(), "..", "..", "build", "assets", "templates", "gsap.min.js"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function locateTemplates() {
  const candidates = [
    path.join(process.resourcesPath ?? "", "templates"),
    path.join(process.cwd(), "build", "assets", "templates"),
    path.join(process.cwd(), "..", "..", "build", "assets", "templates"),
  ];
  for (const c of candidates) if (existsSync(path.join(c, "manifest.json"))) return c;
  return null;
}

function locateWebDist() {
  const candidates = [
    path.join(process.resourcesPath ?? "", "web-dist"),
    path.join(process.cwd(), "apps", "web", "dist"),
    path.join(process.cwd(), "..", "..", "apps", "web", "dist"),
  ];
  for (const c of candidates) if (existsSync(path.join(c, "index.html"))) return c;
  return null;
}

function locateServer() {
  const candidates = [
    path.join(process.resourcesPath ?? "", "bin", process.platform === "win32" ? "dataVideo-server.exe" : "dataVideo-server"),
    path.join(process.cwd(), "build", "release", process.platform === "win32" ? "windows-x64" : "macos-arm64",
      process.platform === "win32" ? "dataVideo-server.exe" : "dataVideo-server"),
    path.join(process.cwd(), "..", "..", "build", "release", process.platform === "win32" ? "windows-x64" : "macos-arm64",
      process.platform === "win32" ? "dataVideo-server.exe" : "dataVideo-server"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function waitForServer(timeoutMs = 30000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`${BASE}/api/health`, (res) => { res.resume(); resolve(); });
      req.on("error", () => {
        if (Date.now() - t0 > timeoutMs) reject(new Error("服务启动超时"));
        else setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

function startServer() {
  const bin = locateServer();
  if (!bin) {
    dialog.showErrorBox("缺少服务组件", "未找到 dataVideo-server，请重新安装应用。");
    app.quit();
    return;
  }
  // 用户数据目录（渲染产物/设置都放这里）
  const userData = path.join(app.getPath("userData"), "data");
  mkdirSync(userData, { recursive: true });
  // 从用户数据目录读 .env（可选）
  const envFile = path.join(app.getPath("userData"), ".env");
  const webRoot = locateWebDist();
  const tplRoot = locateTemplates();
  const gsapFile = locateGsap();
  const env = { ...process.env, JOB_DATA_DIR: userData, STANDALONE: "1", NO_OPEN: "1",
    ...(webRoot ? { WEB_ROOT: webRoot } : {}), ...(tplRoot ? { TEMPLATE_ROOT: tplRoot } : {}),
    ...(gsapFile ? { GSAP_FILE: gsapFile } : {}) };
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim();
    }
  }
  serverProc = spawn(bin, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  serverProc.stdout.on("data", () => {});
  serverProc.stderr.on("data", (d) => console.error("[server]", d.toString().slice(0, 500)));
  serverProc.on("exit", (code) => {
    if (!app.quitting) {
      dialog.showErrorBox("服务异常退出", `dataVideo-server 退出（code ${code}），应用将关闭。`);
      app.quit();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "AI 数据解说短视频工厂",
    backgroundColor: "#0b0e14",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(BASE);
  // 外部链接走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(BASE)) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
  win.on("closed", () => { win = null; });
}

// 固定 userData 路径（productName 与包名不一致时 getPath 会取包名 @data-news）
app.setPath("userData", path.join(app.getPath("appData"), "dataNews"));
app.on("before-quit", () => { app.quitting = true; });
app.on("will-quit", () => { if (serverProc) { try { serverProc.kill(); } catch {} } });
app.on("window-all-closed", () => app.quit());

app.whenReady().then(async () => {
  startServer();
  try {
    await waitForServer();
    await createWindow();
  } catch (e) {
    dialog.showErrorBox("启动失败", String(e.message ?? e));
    app.quit();
  }
});
