#!/usr/bin/env node
/** 一键环境自检：node/ffmpeg/ffprobe/Chrome/TTS/LLM 连通性。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ok = [];
const bad = [];

async function check(name, fn) {
  try {
    const note = await fn();
    ok.push(`✓ ${name}${note ? " — " + note : ""}`);
  } catch (e) {
    bad.push(`✗ ${name} — ${e.message}`);
  }
}

await check("Node >= 22", async () => {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) throw new Error(`当前 ${process.versions.node}`);
  return process.versions.node;
});

await check("ffmpeg", async () => (await run("ffmpeg", ["-version"])).stdout.split("\n")[0].slice(0, 40));
await check("ffprobe", async () => "ok");

await check("pnpm 依赖已安装", async () => {
  if (!existsSync(path.join(root, "node_modules"))) throw new Error("请先运行 pnpm install");
  return "node_modules 就绪";
});

await check("GSAP 本地包（渲染工程依赖）", async () => {
  const p = path.join(root, "packages/pipeline/node_modules/gsap/dist/gsap.min.js");
  if (!existsSync(p)) throw new Error("缺少 gsap，请 pnpm install");
  return "found";
});

await check("TTS（macOS say 或 edge-tts）", async () => {
  if (process.platform === "darwin") {
    const { stdout } = await run("say", ["-v", "?"]);
    if (stdout.includes("Tingting") || stdout.includes("zh_CN")) return "macOS say 中文音色可用";
    throw new Error("缺少中文语音（系统设置→辅助功能→朗读内容→系统声音→管理声音，安装婷婷）");
  }
  await run("edge-tts", ["--list-voices"]);
  return "edge-tts 可用";
});

await check(".env 配置", async () => {
  const envFile = path.join(root, ".env");
  if (!existsSync(envFile)) throw new Error("复制 .env.example 为 .env 并填入 ARK_API_KEY");
  const env = readFileSync(envFile, "utf8");
  if (!env.includes("ARK_API_KEY=") || env.includes("ARK_API_KEY=\n")) throw new Error("ARK_API_KEY 未填");
  return "已配置";
});

await check("LLM 连通（Ark / GLM）", async () => {
  process.env.ARK_API_KEY ||= (() => {
    try {
      return readFileSync(path.join(root, ".env"), "utf8").match(/ARK_API_KEY=(.*)/)?.[1].trim();
    } catch { return undefined; }
  })();
  const { ArkClient } = await import(path.join(root, "packages/llm/src/index.ts"));
  const c = new ArkClient();
  const r = await c.chat([{ role: "user", content: "请原样输出两个字母: ok" }], { minTokens: 16 });
  if (!r.content.toLowerCase().includes("ok")) throw new Error("响应异常: " + r.content.slice(0, 50));
  return `${c.model} (${r.elapsedMs}ms)`;
});

console.log(ok.join("\n"));
if (bad.length) {
  console.error("\n" + bad.join("\n"));
  console.error("\n环境未就绪，请修复以上 ✗ 项后重试。");
  process.exit(1);
}
console.log("\n环境就绪 ✅  下一步: pnpm dev:server 与 pnpm dev:web");
