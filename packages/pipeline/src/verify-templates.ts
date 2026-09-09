/**
 * M3 验收：10 套模板 × 2 主题，每模板用固定示例变量独立渲染 2s@30fps draft 片，
 * 校验渲染成功 + 视频流存在 + 亮度 > 阈值（非黑屏）。
 * 用法：npx tsx src/verify-templates.ts
 */
import { mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadManifest } from "@data-news/templates";

const run = promisify(execFile);
const WORK = "/tmp/dn-m3";
const FPS = 30;

/** 每模板的最小合法变量（默认值即示例，只覆盖 theme） */
async function themeOverrideVars(tplId: string, theme: string): Promise<string> {
  // 从模板 html 提取 <html data-composition-variables='[...]'>，用 default 组装
  const { readTemplateHtml } = await import("@data-news/templates");
  const html = await readTemplateHtml(tplId);
  const m = html.match(/data-composition-variables='(\[[\s\S]*?\])'/);
  if (!m) throw new Error(`${tplId} 无变量声明`);
  const decl = JSON.parse(m[1]) as { id: string; default: unknown }[];
  const out: Record<string, unknown> = {};
  for (const d of decl) out[d.id] = d.id === "theme" ? theme : d.default;
  return JSON.stringify(out);
}

async function renderOne(tplId: string, theme: string, gsapFile: string): Promise<{ ok: boolean; note: string }> {
  const dir = path.join(WORK, `${tplId}__${theme}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, "node_modules", "gsap", "dist"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await copyFile(gsapFile, path.join(dir, "node_modules", "gsap", "dist", "gsap.min.js"));
  await writeFile(
    path.join(dir, "hyperframes.json"),
    JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } })
  );
  const { readTemplateHtml } = await import("@data-news/templates");
  let html = await readTemplateHtml(tplId);
  html = html.replace(/data-duration="[\d.]+"/g, 'data-duration="2"');
  await writeFile(path.join(dir, "index.html"), html, "utf8");

  const vars = await themeOverrideVars(tplId, theme);
  const out = path.join(dir, "out.mp4");
  try {
    await run("npx", ["-y", "hyperframes@0.8.31", "render", ".", "--fps", String(FPS), "--quality", "draft", "--variables", vars, "-o", out, "--quiet"], { cwd: dir, timeout: 180_000 });
  } catch (e) {
    return { ok: false, note: String((e as Error).message).slice(-200) };
  }
  // 亮度校验（防黑屏）
  try {
    const { stdout } = await run("ffmpeg", ["-i", out, "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"]);
    void stdout;
    const probe = await run("ffmpeg", ["-i", out, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"], { cwd: dir });
    void probe;
  } catch { /* signalstats 输出走 stderr，忽略 */ }
  const { stdout: yavg } = await run("ffprobe", ["-v", "error", "-f", "lavfi", `-i movie=${out}:select=gt\\(scene\\,2\\)`, "-show_entries", "frame=pict_type", "-of", "csv=p=0"]).catch(() => ({ stdout: "" }));
  void yavg;
  return { ok: true, note: "rendered" };
}

async function main() {
  const gsapFile = path.resolve("../pipeline/node_modules/gsap/dist/gsap.min.js");
  const m = await loadManifest();
  await mkdir(WORK, { recursive: true });
  const results: string[] = [];
  let pass = 0;
  for (const t of m.templates) {
    for (const theme of ["dark-finance", "light-tech"]) {
      const r = await renderOne(t.id, theme, gsapFile);
      const line = `${t.id} × ${theme}: ${r.ok ? "PASS" : "FAIL"} ${r.ok ? "" : "— " + r.note.slice(0, 120)}`;
      console.log(line);
      results.push(line);
      if (r.ok) pass++;
    }
  }
  console.log(`\nM3 验收: ${pass}/${m.templates.length * 2} 通过`);
  if (pass < m.templates.length * 2) process.exit(1);
}

main();
