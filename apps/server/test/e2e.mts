/**
 * M5 集成测试：全流程 API 冒烟（真实 LLM + TTS + 渲染，draft 档）。
 * 前置：.env 已配置；server 未启动（本脚本自己拉起再关闭）。
 * 用法：npx tsx apps/server/test/e2e.mts
 */
import path from "node:path";
import { readFile, stat, rm } from "node:fs/promises";

// e2e.mts 位于 apps/server/test/ → 仓库根是上三级
const ROOT = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "..", "..", "..");

// 加载仓库根 .env（server 子进程不继承交互 shell 的环境）
try {
  const dotenv = await readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of dotenv.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* .env 不存在则沿用进程环境 */ }
const PORT = 8890;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

// 1. 启动 server（bash -l 里的全局 node 是 x64，与 arm64 esbuild 冲突；
//    必须复用当前 arm64 进程的 node 可执行文件与 tsx import hook）
const { execFile } = await import("node:child_process");
const server = execFile(
  process.execPath,
  ["--import", "tsx", "src/index.ts"],
  {
    cwd: path.join(ROOT, "apps/server"),
    env: { ...process.env, PORT: String(PORT), RENDER_QUALITY: "draft", RENDER_FPS: "60" },
  },
  () => {/* 进程退出回调（kill 后触发） */}
);
let serverLog = "";
server.stdout?.on("data", (d) => (serverLog += d));
server.stderr?.on("data", (d) => (serverLog += d));

const waitForServer = async (): Promise<boolean> => {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      return r.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
};

try {
  console.log("[1] server 启动");
  assert(await waitForServer(), "server 在 10s 内监听");

  console.log("[2] 健康检查与模板清单");
  const templates = (await (await fetch(`${BASE}/api/templates`)).json()) as { id: string }[];
  assert(templates.length === 10, "10 套模板", `got ${templates.length}`);

  console.log("[3] 创建任务（示例 CSV，限模板避免 LLM 输出过大）");
  const csv = await readFile(path.join(ROOT, "examples/finance-half-year.csv"), "utf8");
  const createRes = await fetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csv, quality: "draft" }),
  });
  assert(createRes.status === 202, "创建返回 202");
  const { jobId } = (await createRes.json()) as { jobId: string };

  console.log(`[4] 轮询任务 ${jobId} 至完成（SSE 事件抽样）`);
  const seen = new Set<string>();
  const es = await fetch(`${BASE}/api/jobs/${jobId}/events`);
  const reader = es.body!.getReader();
  const decoder = new TextDecoder();
  let final: { status: string; error?: string } | undefined;
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      if (!line.startsWith("data:")) continue;
      const e = JSON.parse(line.slice(5)) as { status: string; error?: string };
      seen.add(e.status);
      if (e.status === "done" || e.status === "failed") final = e;
    }
    if (final) break;
  }
  assert(final?.status === "done", "任务成功完成", `final=${JSON.stringify(final)} log=${serverLog.slice(-400)}`);
  for (const s of ["scripting", "tts", "composing", "rendering", "done"]) {  // ingesting 一闪而过，可能不出现于 SSE
    assert(seen.has(s), `状态机经过 ${s}`);
  }

  console.log("[5] 产物校验");
  const detail = (await (await fetch(`${BASE}/api/jobs/${jobId}`)).json()) as {
    script?: { scenes: unknown[]; title: string };
    downloads?: { video: string; project: string };
  };
  assert(!!detail.script, "返回脚本");
  assert((detail.script?.scenes.length ?? 0) >= 2, "脚本 >=2 场景");
  assert(!!detail.downloads?.video, "返回下载地址");

  const videoRes = await fetch(`${BASE}${detail.downloads!.video}`);
  const videoBuf = Buffer.from(await videoRes.arrayBuffer());
  assert(videoRes.status === 200 && videoBuf.length > 100_000, "成片下载 >100KB", `${videoBuf.length}B`);
  await rm("/tmp/dn-e2e-video.mp4", { force: true });
  await (await import("node:fs/promises")).writeFile("/tmp/dn-e2e-video.mp4", videoBuf);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const probe = await run("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", "/tmp/dn-e2e-video.mp4",
  ]);
  const streams = JSON.parse(probe.stdout).streams as { codec_type: string; width?: number }[];
  assert(streams.some((s) => s.codec_type === "audio"), "成片含音轨");
  assert(streams.some((s) => s.codec_type === "video" && s.width === 1920), "成片 1080p");

  const zipRes = await fetch(`${BASE}${detail.downloads!.project}`);
  assert(zipRes.status === 200, "工程包下载");
} catch (e) {
  failed++;
  console.error("集成测试异常:", (e as Error).message);
} finally {
  server.kill("SIGTERM");
}

console.log(`\n集成测试: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
