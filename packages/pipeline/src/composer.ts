import { mkdir, writeFile, copyFile, rm, access } from "node:fs/promises";
import path from "node:path";
import type { VideoScript, Scene } from "@data-news/shared";
import { readTemplateHtml, getTemplate } from "@data-news/templates";

/** 渲染工作区布局：
 * <dir>/
 *   index.html                 装配好的主组合（多场景按时间轴串联 + 全局音轨）
 *   assets/vo.mp3              整条解说音轨（固定路径契约）
 *   compositions/scene-N.html  每场景子组合（变量经 data-variable-values 注入）
 *   node_modules/gsap/dist/gsap.min.js  本地 GSAP
 */
export interface WorkspaceLayout {
  root: string;
  indexHtml: string;
  voFile: string;
  totalDurationSec: number;
  sceneDirs: string[];
}

async function locateGsap(explicit?: string): Promise<string | undefined> {
  const candidates = explicit
    ? [explicit]
    : [
        fileUrlSibling("gsap.min.js"),
        path.join(process.cwd(), "node_modules", "gsap", "dist", "gsap.min.js"),
        path.join(process.cwd(), "node_modules", ".pnpm", "node_modules", "gsap", "dist", "gsap.min.js"),
        // pkg 便携发行布局
        path.join(path.dirname(process.execPath), "resources", "gsap.min.js"),
        path.join(path.dirname(process.execPath), "resources", "templates", "gsap.min.js"),
      ];
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** 相对本包的 gsap 兜底路径；CJS 打包环境下退回 cwd 定位 */
function fileUrlSibling(name: string): string {
  try {
    const url = typeof import.meta?.url === "string" ? import.meta.url : undefined;
    if (url) return fileURLToPath(new URL(`../node_modules/gsap/dist/${name}`, url));
  } catch { /* fallthrough */ }
  return path.join(process.cwd(), "node_modules", "gsap", "dist", name);
}

import { fileURLToPath } from "node:url";

/** 生成单场景子组合文件：
 * - 模板声明区（<html data-composition-variables='[...]'>）保持默认值不变
 * - scene.data 写入 HTML 注释块中的 JSON（仅作记录）；真实值由主组合挂载点的
 *   data-variable-values 逐实例注入（HyperFrames 官方变量机制）
 * - data-duration 改为该场景实际时长；剥掉模板自带 <audio>（音轨统一挂主组合） */
export async function writeSceneComposition(
  scene: Scene,
  durationSec: number,
  outFile: string
): Promise<void> {
  let html = await readTemplateHtml(scene.template);

  // 时长：替换所有 data-duration="<默认>"
  html = html.replace(/data-duration="[\d.]+"/g, `data-duration="${durationSec.toFixed(2)}"`);
  // 剥掉子组合音轨（避免与主组合音轨重叠）；若模板没有 audio 也不报错
  html = html.replace(/<audio[^>]*src="assets\/vo\.mp3"[^>]*><\/audio>\s*/g, "");

  // 记录场景数据（人读；渲染值以挂载点 data-variable-values 为准）
  const note = `<!-- scene-data: ${JSON.stringify(scene.data).replace(/--/g, "—")} -->\n`;
  html = note + html;

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, html, "utf8");
}

/** 装配完整工作区。sceneDurations[i] 为每场景秒数（含缓冲），voFile 为已生成的解说 mp3。 */
export async function composeWorkspace(
  opts: { script: VideoScript; sceneDurations: number[]; voFile: string; outDir: string; gsapFile?: string }
): Promise<WorkspaceLayout> {
  const { script, sceneDurations, voFile, outDir } = opts;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "assets"), { recursive: true });
  await mkdir(path.join(outDir, "compositions"), { recursive: true });

  // gsap 本地化
  const gsapSrc = await locateGsap(opts.gsapFile);
  const gsapDir = path.join(outDir, "node_modules", "gsap", "dist");
  await mkdir(gsapDir, { recursive: true });
  if (gsapSrc) {
    await copyFile(gsapSrc, path.join(gsapDir, "gsap.min.js"));
  } else {
    throw new Error("无法定位 gsap.min.js——请确认 pnpm install 已安装 gsap 依赖");
  }

  // VO 固定路径（voFile 在 outDir 内时跳过自拷贝）
  const voDest = path.join(outDir, "assets", "vo.mp3");
  if (path.resolve(voFile) !== path.resolve(voDest)) {
    await copyFile(voFile, voDest);
  }

  // 每场景子组合（无音轨）
  const sceneFiles: string[] = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const dur = sceneDurations[i];
    const f = path.join(outDir, "compositions", `scene-${i}.html`);
    await writeSceneComposition(scene, dur, f);
    sceneFiles.push(`compositions/scene-${i}.html`);
  }

  // 主组合 index.html：串联场景（每挂载点注入 data-variable-values）+ 全局音轨
  const total = sceneDurations.reduce((a, b) => a + b, 0);
  const mounts = sceneFiles
    .map((f, i) => {
      const start = sceneDurations.slice(0, i).reduce((a, b) => a + b, 0);
      const values = JSON.stringify({ ...script.scenes[i].data, theme: script.theme }).replace(/'/g, "&#39;");
      return `    <div id="scene-mount-${i}" data-composition-id="scene-mount-${i}" data-composition-src="${f}" data-start="${start.toFixed(
        2
      )}" data-duration="${sceneDurations[i].toFixed(2)}" data-width="1920" data-height="1080" data-variable-values='${values}'></div>`;
    })
    .join("\n");

  const indexHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1920, height=1080" />
<script src="node_modules/gsap/dist/gsap.min.js"></script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:1920px; height:1080px; overflow:hidden; background:#000; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${total.toFixed(
    2
  )}" data-width="1920" data-height="1080">
${mounts}
  <audio id="vo-audio-main" class="clip" data-start="0" data-duration="${total.toFixed(
    2
  )}" data-track-index="2" src="assets/vo.mp3"></audio>
</div>
<script>
  // 主组合自身无动画，仅作为场景挂载容器；注册空 timeline 避免 readiness 等待超时
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = gsap.timeline({ paused: true });
</script>
</body>
</html>`;

  await writeFile(path.join(outDir, "index.html"), indexHtml, "utf8");

  await writeFile(
    path.join(outDir, "hyperframes.json"),
    JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }),
    "utf8"
  );

  return {
    root: outDir,
    indexHtml: path.join(outDir, "index.html"),
    voFile: voDest,
    totalDurationSec: total,
    sceneDirs: sceneFiles,
  };
}
