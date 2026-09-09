/**
 * 样例视频库生成器：为每个模板 × 每个主题渲染 2.5s 无声样例 mp4。
 * 输出到 packages/templates/samples/<template>__<theme>.mp4（web 通过 server 静态接口访问）。
 * 幂等：已存在的样例跳过（删除目录可强制重生成）。
 * 用法：npx tsx src/gen-samples.ts [--force]
 */
import { mkdir, copyFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadManifest, TEMPLATE_PKG_ROOT } from "@data-news/templates";
import { TEMPLATE_IDS } from "@data-news/shared";

const run = promisify(execFile);
const FORCE = process.argv.includes("--force");
const WORK = "/tmp/dn-samples";
const THEMES = ["dark-finance", "light-tech", "violet-trend", "warm-sunrise", "cool-mint", "ink-classic"];
const SAMPLES_DIR = path.join(TEMPLATE_PKG_ROOT, "samples");

const GSAP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline/node_modules/gsap/dist/gsap.min.js");

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function renderSample(tplId: string, theme: string, htmlFile: string, varsDefault: Record<string, string>): Promise<void> {
  const out = path.join(SAMPLES_DIR, `${tplId}__${theme}.mp4`);
  if (!FORCE && (await exists(out))) return;

  const dir = path.join(WORK, `${tplId}__${theme}`);
  await mkdir(path.join(dir, "node_modules", "gsap", "dist"), { recursive: true });
  await copyFile(GSAP, path.join(dir, "node_modules", "gsap", "dist", "gsap.min.js"));
  await writeFile(
    path.join(dir, "hyperframes.json"),
    JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } })
  );

  const fs = await import("node:fs/promises");
  let html = await fs.readFile(htmlFile, "utf8");
  html = html.replace(/data-duration="[\d.]+"/g, 'data-duration="2.5"');
  await fs.writeFile(path.join(dir, "index.html"), html, "utf8");

  // 变量：用声明默认值但覆盖 theme
  const m = html.match(/data-composition-variables='(\[[\s\S]*?\])'/);
  const vars: Record<string, unknown> = {};
  if (m) {
    for (const d of JSON.parse(m[1]) as { id: string; default: unknown }[]) {
      vars[d.id] = d.id === "theme" ? theme : d.default;
    }
  }

  await run("npx", [
    "-y", "hyperframes@0.8.31", "render", ".",
    "--fps", "30", "--quality", "draft",
    "--variables", JSON.stringify(vars),
    "-o", out, "--quiet",
  ], { cwd: dir, timeout: 180_000 });
}

async function main() {
  const m = await loadManifest();
  await mkdir(SAMPLES_DIR, { recursive: true });
  const only = process.argv.filter((a) => a.startsWith("--tpl=")).map((a) => a.split("=")[1]);

  let done = 0;
  for (const tpl of m.templates) {
    if (only.length && !only.includes(tpl.id)) continue;
    const htmlFile = path.join(TEMPLATE_PKG_ROOT, tpl.html);
    for (const theme of THEMES) {
      const t0 = Date.now();
      try {
        await renderSample(tpl.id, theme, htmlFile, {});
        done++;
        console.log(`${tpl.id} × ${theme}: ${(Date.now() - t0) / 1000 | 0}s`);
      } catch (e) {
        console.error(`${tpl.id} × ${theme}: FAIL ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }
  console.log(`\n样例生成完成: ${done} 个 → ${SAMPLES_DIR}`);
}

main();
