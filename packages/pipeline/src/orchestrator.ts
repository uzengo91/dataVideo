import { mkdir, copyFile, mkdtemp, stat, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { CreateJobRequest, VideoScript, JobEvent } from "@data-news/shared";
import { ArkClient } from "@data-news/llm";
import { synthesizeVoiceoverCfg, probeDurationSec } from "@data-news/tts";
import { ingestCsv } from "./ingest.js";
import { planScript } from "./script-planner.js";
import { composeWorkspace } from "./composer.js";
import { renderWorkspace, runCheck } from "./renderer.js";

export interface PipelineHooks {
  onEvent?: (e: Partial<JobEvent> & { status: JobEvent["status"] }) => void;
  onRenderProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export interface PipelineResult {
  jobId: string;
  script: VideoScript;
  videoFile: string;
  workspaceDir: string;
  elapsedMs: number;
  videoBytes: number;
  voDurationSec: number;
  totalDurationSec: number;
}

/** 每场景时长 = max(模板 min, VO 按字数折算 + 尾部缓冲) */
function sceneDurations(script: VideoScript, voDurationSec: number): number[] {
  const totalChars = script.scenes.reduce((a, s) => a + s.narration.length, 0) || 1;
  const perScene = script.scenes.map((s) => {
    void s;
    return 0;
  });
  // 简化模型：VO 均匀铺在全部场景上，按字数占比分配；每场景再 +0.8s 缓冲，但不低于模板 min
  void perScene;
  return script.scenes.map((s) => {
    const share = (s.narration.length / totalChars) * voDurationSec;
    return share + 0.8; // compose 阶段再 clamp 到模板 min/max
  });
}

async function clampToTemplate(durations: number[], script: VideoScript): Promise<number[]> {
  const { getTemplate } = await import("@data-news/templates");
  const out: number[] = [];
  for (let i = 0; i < durations.length; i++) {
    const tpl = await getTemplate(script.scenes[i].template);
    out.push(Math.min(Math.max(durations[i], tpl.duration.min), tpl.duration.max));
  }
  return out;
}

/** 单任务全流程：CSV → 成片。抛错则任务失败。 */
export async function runPipeline(
  jobId: string,
  req: CreateJobRequest,
  hooks: PipelineHooks = {}
): Promise<PipelineResult> {
  const t0 = Date.now();
  const emit = (status: JobEvent["status"], progress: number, message = "") =>
    hooks.onEvent?.({ jobId, status, progress, message, at: new Date().toISOString() });

  const dataRoot = process.env.JOB_DATA_DIR
    ? path.resolve(process.env.JOB_DATA_DIR)
    : path.resolve(process.cwd(), "data");
  const jobDir = path.join(dataRoot, jobId);
  await mkdir(jobDir, { recursive: true });

  // 1. ingest
  emit("ingesting", 5, "解析 CSV");
  const table = ingestCsv(req.csv);

  // 2. script：用户确认过的脚本直接用（跳过 LLM）；否则 AI 生成
  let script: VideoScript;
  if (req.scriptOverride) {
    emit("scripting", 15, "使用确认后的脚本");
    const { ThemeSchema, VoiceSchema } = await import("@data-news/shared");
    const theme = ThemeSchema.parse(req.scriptOverride.theme);
    const voice = VoiceSchema.parse(req.scriptOverride.voice?.voice ?? req.voice ?? "zh-female-1");
    script = {
      title: req.scriptOverride.title,
      theme,
      voice,
      scenes: req.scriptOverride.scenes.map((s) => ({
        template: s.template,
        headline: s.headline,
        subline: s.subline,
        narration: s.narration,
        data: s.data,
        sourceRefs: [],
      })),
    };
    // 模板变量契约校验（与 LLM 生成路径同标准）
    const { getTemplate, validateSceneVars } = await import("@data-news/templates");
    for (const scene of script.scenes) {
      const tpl = await getTemplate(scene.template);
      const merged: Record<string, unknown> = { ...scene.data, headline: scene.headline, theme: script.theme };
      if (scene.subline) merged.subline = scene.subline;
      const errs = validateSceneVars(tpl, merged);
      if (errs.length) {
        throw new Error(`场景「${scene.headline}」变量校验失败: ${errs.join("; ")}`);
      }
    }
  } else {
    emit("scripting", 15, "AI 生成脚本");
    const client = new ArkClient();
    script = await planScript(table, {
      titleHint: req.titleHint,
      voice: req.voice,
      theme: req.theme,
      templates: req.templates,
      client,
    });
  }
  await writeFile(path.join(jobDir, "script.json"), JSON.stringify(script, null, 2), "utf8");

  // 3. tts：全部解说词串联成一条音轨（引擎/音色由 voiceConfig 决定，默认自动选最优）
  emit("tts", 30, "合成语音");
  const narration = script.scenes.map((s) => s.narration).join("。");
  const voTmp = path.join(jobDir, "vo-raw.mp3");
  const vo = await synthesizeVoiceoverCfg(narration, req.voiceConfig, voTmp);

  // 场景时长 = VO 占比 + 缓冲，clamp 到模板区间
  const durations = await clampToTemplate(sceneDurations(script, vo.durationSec), script);

  // 4. compose
  emit("composing", 40, "装配渲染工程");
  const wsTmp = await mkdtemp(path.join(tmpdir(), "dn-ws-"));
  const gsapSrc = await locateGsapForCompose();
  const ws = await composeWorkspace({
    script,
    sceneDurations: durations,
    voFile: vo.file,
    outDir: wsTmp,
    gsapFile: gsapSrc,
  });
  // 音轨与总时长对齐：若场景总时长 > VO，音频自然结束即可（HyperFrames 不循环）
  const totalDur = ws.totalDurationSec;

  // 5. check 门禁（错误拦截、警告放行；完整日志落盘）
  emit("rendering", 45, "质检");
  const check = await runCheck(ws.root, path.join(jobDir, "check.log"));
  if (!check.ok) {
    const errLines = check.output.split("\n").filter((l) => /✗|✘|error\(s\)/i.test(l));
    throw new Error(`hyperframes check 未通过:\n${errLines.slice(0, 20).join("\n") || check.output.slice(-800)}\n（完整日志: ${path.join(jobDir, "check.log")}）`);
  }

  // 6. render
  emit("rendering", 50, "渲染中");
  const outFile = path.join(jobDir, "video.mp4");
  const render = await renderWorkspace({
    workspaceDir: ws.root,
    variables: {}, // 变量已在子组合默认值中；主组合无变量
    fps: Number(process.env.RENDER_FPS ?? 60),
    quality: (process.env.RENDER_QUALITY as "draft" | "standard" | "high") ?? "standard",
    outFile,
    onProgress: (p) => {
      hooks.onRenderProgress?.(p);
      emit("rendering", 50 + Math.round(p * 0.4), `渲染 ${p}%`);
    },
    signal: hooks.signal,
  });

  // 7. verify：产物存在 + 含音轨 + 时长合理
  emit("verifying", 92, "校验产物");
  const st = await stat(outFile);
  if (st.size < 10_000) throw new Error(`成片过小 (${st.size}B)，疑似渲染失败`);
  const probe = await probeDurationSec(outFile);
  if (Math.abs(probe - totalDur) > 1.5) {
    throw new Error(`成片时长 ${probe.toFixed(2)}s 与预期 ${totalDur.toFixed(2)}s 偏差过大`);
  }

  // 8. 工程包归档（供用户手工微调重渲）
  emit("verifying", 96, "打包工程");
  const { default: zipper } = await import("./zip.js");
  const projectZip = path.join(jobDir, "project.zip");
  await zipper(ws.root, projectZip);

  // 清理临时 VO
  await rm(voTmp, { force: true });

  emit("done", 100, "完成");
  return {
    jobId,
    script,
    videoFile: outFile,
    workspaceDir: ws.root,
    elapsedMs: Date.now() - t0,
    videoBytes: st.size,
    voDurationSec: vo.durationSec,
    totalDurationSec: totalDur,
  };
}

async function locateGsapForCompose(): Promise<string | undefined> {
  // 主候选：本包 node_modules 里的 gsap（pnpm symlink，与 cwd 无关）；CJS 打包下退回 cwd
  let primary: string | undefined;
  try {
    const url = typeof import.meta?.url === "string" ? import.meta.url : undefined;
    if (url) primary = fileURLToPath(new URL("../node_modules/gsap/dist/gsap.min.js", url));
  } catch { /* CJS 环境 */ }
  const candidates = [
    ...(primary ? [primary] : []),
    path.join(process.cwd(), "node_modules", "gsap", "dist", "gsap.min.js"),
    path.join(process.cwd(), "node_modules", ".pnpm", "node_modules", "gsap", "dist", "gsap.min.js"),
    // pkg 快照路径：可执行文件旁的 resources/
    path.join(path.dirname(process.execPath), "resources", "gsap.min.js"),
  ];
  for (const c of candidates) {
    try {
      await access(c);
      return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}
