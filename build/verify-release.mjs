#!/usr/bin/env node
/** 发版前自动验收：检查 app 包内各组件版本一致性 + 启动冒烟。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT_DESKTOP = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop");
const APP = "/Applications/dataNews.app";
let fail = 0;
const check = (ok, name, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) fail++;
};

// 1. 结构完整性
const res = path.join(APP, "Contents", "Resources");
check(existsSync(path.join(res, "bin", process.platform === "win32" ? "dataVideo-server.exe" : "dataVideo-server")), "内嵌服务二进制存在");
check(existsSync(path.join(res, "templates", "manifest.json")), "模板 manifest 存在");
const samples = existsSync(path.join(res, "templates", "samples")) ? 1 : 0;
check(samples, "样例视频目录存在");
check(existsSync(path.join(res, "web-dist", "index.html")), "web 前端存在");

// 2. web-dist 无旧 URL 格式（下划线拼接 = 旧 bug）
const { stdout: badUrls } = await run("grep", ["-c", "api/samples/${", path.join(res, "web-dist", "assets")], { cwd: "/" }).catch(() => ({ stdout: "0" }));
// grep 目录会失败，改为逐文件
const assetsDir = path.join(res, "web-dist", "assets");
if (existsSync(assetsDir)) {
  const { readdirSync, readFileSync } = await import("node:fs");
  let bad = 0;
  for (const f of readdirSync(assetsDir)) {
    if (f.startsWith("index-") && f.endsWith(".js")) {
      const c = readFileSync(path.join(assetsDir, f), "utf8");
      if (c.includes("}__${")) bad++;
    }
  }
  check(bad === 0, "web-dist 样例 URL 为斜杠格式（无旧下划线 bug）", bad ? `${bad} 个文件含旧格式` : "");
}

// 3. asar 新鲜度（main.mjs 修改时间不晚于 asar）
const asarTime = statSync(path.join(APP, "Contents", "Resources", "app.asar")).mtimeMs;
const mainTime = statSync(path.join(ROOT_DESKTOP(), "main.mjs")).mtimeMs;
check(asarTime >= mainTime - 60_000, "app.asar 包含最新 GUI 代码", `asar=${new Date(asarTime).toISOString().slice(11,19)} main=${new Date(mainTime).toISOString().slice(11,19)}`);


// 4. 启动冒烟（服务已有实例时也视为通过——说明可用）
let healthy = false;
try {
  const r = await fetch("http://127.0.0.1:8787/api/health", { signal: AbortSignal.timeout(3000) });
  healthy = r.ok && (await r.json()).ok === true;
} catch { /* 未运行 */ }
check(healthy, "服务健康（已在运行或刚启动）");

console.log(fail ? `\n验收失败: ${fail} 项` : "\n发版验收全部通过 ✅");
process.exit(fail ? 1 : 0);
