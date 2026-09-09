import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { access, constants } from "node:fs/promises";
import path from "node:path";

export interface RenderOptions {
  workspaceDir: string;
  variables: Record<string, string | number>;
  fps?: number;
  quality?: "draft" | "standard" | "high";
  outFile: string;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  outFile: string;
  elapsedMs: number;
  frames: number;
}

const HYPERFRAMES_VERSION = "0.8.31";

/** 解析 hyperframes 可执行入口：优先本地 node_modules/.bin，否则 npx */
async function resolveCli(): Promise<{ cmd: string; baseArgs: string[] }> {
  const localBin = path.join(process.cwd(), "node_modules", ".bin", "hyperframes");
  try {
    await access(localBin, constants.X_OK);
    return { cmd: localBin, baseArgs: [] };
  } catch {
    return { cmd: "npx", baseArgs: ["-y", `hyperframes@${HYPERFRAMES_VERSION}`] };
  }
}

/** 渲染工作区 → MP4。进度从 stdout 的 "█" 块比例粗略解析（0-100）。 */
export async function renderWorkspace(opts: RenderOptions): Promise<RenderResult> {
  const { cmd, baseArgs } = await resolveCli();
  const { workspaceDir, variables, fps = 60, quality = "standard", outFile } = opts;

  const args = [
    ...baseArgs,
    "render", ".",
    "--fps", String(fps),
    "--quality", quality,
    "--variables", JSON.stringify(variables),
    "-o", path.resolve(outFile),
  ];

  return new Promise<RenderResult>((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, {
      cwd: workspaceDir,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let frames = 0;

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      // 进度： "framesCompleted":N 与 totalFrames，或 █████░░░ 比例
      const framesMatch = stdout.match(/"framesCompleted":(\d+)[\s\S]*?"totalFrames":(\d+)/);
      if (framesMatch && opts.onProgress) {
        frames = Number(framesMatch[2]);
        opts.onProgress(Math.round((Number(framesMatch[1]) / frames) * 100));
      } else {
        const bar = s.match(/([█░]+)\s+(\d+)%/);
        if (bar && opts.onProgress) opts.onProgress(Number(bar[2]));
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ outFile, elapsedMs: Date.now() - t0, frames });
      } else {
        reject(new Error(`hyperframes render 退出码 ${code}\n--- stderr 尾部 ---\n${stderr.slice(-2000)}\n--- stdout 尾部 ---\n${stdout.slice(-2000)}`));
      }
    });
    opts.signal?.addEventListener("abort", () => child.kill("SIGTERM"));
  });
}

/** 渲染前质检门禁：hyperframes check。返回 lint 是否通过（警告不算失败）。 */
export async function runCheck(workspaceDir: string, logFile?: string): Promise<{ ok: boolean; output: string }> {
  const { cmd, baseArgs } = await resolveCli();
  return new Promise((resolve) => {
    const child = spawn(cmd, [...baseArgs, "check", "."], {
      cwd: workspaceDir,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (e) => resolve({ ok: false, output: String(e) }));
    child.on("close", () => {
      // check 的退出码不稳定（1 可能只是警告），以输出中的 "N error(s)" 计数为准
      if (logFile) {
        writeFile(logFile, out, "utf8").catch(() => {});
      }
      resolve({ ok: !hasErrors(out), output: out });
    });
  });
}

/** 从 check 输出判断是否存在 error 级问题（"N error(s)" 且 N>0） */
function hasErrors(output: string): boolean {
  const m = output.match(/(\d+)\s+error\(s\)/);
  return !!m && Number(m[1]) > 0;
}
