import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Voice, VoiceConfig } from "@data-news/shared";
import { OmnivoiceProvider } from "./omnivoice.js";
import { ENGINES, parseVoiceName, registerEngine, type EngineDef } from "./engines.js";

// 注册本地引擎到统一目录
registerEngine("say", {
  id: "say",
  label: "macOS say",
  needsKey: false,
  free: true,
  voices: ["zh-female-1", "zh-male-1", "en-female-1", "en-male-1"],
  synth: async ({ text, outFile }) => {
    const provider = new MacosSayProvider();
    await provider.synthesize(text, "zh-female-1", outFile);
  },
} as EngineDef);
registerEngine("omnivoice", {
  id: "omnivoice",
  label: "OmniVoice（本地 AI·可选音色）",
  needsKey: false,
  free: true,
  selfHosted: true,
  voices: ["女，青年，中音调", "男，青年，中音调", "女，中年，中音调", "男，青年，低音调"],
  synth: async ({ text, outFile }) => {
    const provider = new OmnivoiceProvider();
    await provider.synthesize(text, "zh-female-1", outFile);
  },
} as EngineDef);

const run = promisify(execFile);

export interface TtsResult {
  /** 生成的 mp3 绝对路径 */
  file: string;
  /** 秒 */
  durationSec: number;
  provider: string;
}

export interface TtsProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  synthesize(text: string, voice: Voice, outFile: string): Promise<void>;
}

// ---------- Provider: macOS say ----------

const SAY_VOICE_MAP: Record<Voice, string> = {
  "zh-female-1": "Tingting",
  "zh-male-1": "Li-mu",
  "en-female-1": "Samantha",
  "en-male-1": "Alex",
};

export class MacosSayProvider implements TtsProvider {
  readonly name = "macos-say";

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
      const { stdout } = await run("say", ["-v", "?"]);
      return stdout.includes("Tingting") || stdout.includes("zh_CN");
    } catch {
      return false;
    }
  }

  async synthesize(text: string, voice: Voice, outFile: string): Promise<void> {
    await mkdir(path.dirname(outFile), { recursive: true });
    const tmpAiff = outFile.replace(/\.mp3$/, ".aiff");
    const sayVoice = SAY_VOICE_MAP[voice] ?? "Tingting";
    try {
      await run("say", ["-v", sayVoice, "-r", "200", "-o", tmpAiff, text]);
      // aiff → mp3，并做首尾静音裁剪与响度归一
      await run("ffmpeg", [
        "-y", "-v", "error",
        "-i", tmpAiff,
        "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-16:TP=-1.5",
        "-codec:a", "libmp3lame", "-q:a", "4",
        outFile,
      ]);
    } finally {
      await rm(tmpAiff, { force: true });
    }
  }
}

// ---------- Provider: edge-tts（跨平台，走 pip 的 edge-tts CLI） ----------

const EDGE_VOICE_MAP: Record<Voice, string> = {
  "zh-female-1": "zh-CN-XiaoxiaoNeural",
  "zh-male-1": "zh-CN-YunxiNeural",
  "en-female-1": "en-US-JennyNeural",
  "en-male-1": "en-US-GuyNeural",
};

export class EdgeTtsProvider implements TtsProvider {
  readonly name = "edge-tts";

  async isAvailable(): Promise<boolean> {
    try {
      await run("edge-tts", ["--list-voices"]);
      return true;
    } catch {
      return false;
    }
  }

  async synthesize(text: string, voice: Voice, outFile: string): Promise<void> {
    await mkdir(path.dirname(outFile), { recursive: true });
    const tmpMp3 = outFile.replace(/\.mp3$/, ".raw.mp3");
    try {
      await run("edge-tts", ["--voice", EDGE_VOICE_MAP[voice], "--text", text, "--write-media", tmpMp3]);
      await run("ffmpeg", [
        "-y", "-v", "error",
        "-i", tmpMp3,
        "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-16:TP=-1.5",
        "-codec:a", "libmp3lame", "-q:a", "4",
        outFile,
      ]);
    } finally {
      await rm(tmpMp3, { force: true });
    }
  }
}

// ---------- 门面 ----------

export type EnginePref = "auto" | "omnivoice" | "macos-say" | "edge-tts";

/** 按可用性自动选择 provider；顺序由 engine 环境变量/参数决定。
 *  timbre 仅 omnivoice 使用（声音设计词表，如 "女，青年，中音调"）。 */
export async function resolveProvider(
  pref: EnginePref | "macos-say" | "edge-tts" = "auto",
  timbre?: string
): Promise<TtsProvider> {
  const candidates: TtsProvider[] =
    pref === "omnivoice" ? [new OmnivoiceProvider(timbre)] :
    pref === "macos-say" ? [new MacosSayProvider()] :
    pref === "edge-tts" ? [new EdgeTtsProvider()] :
    [new OmnivoiceProvider(timbre), new MacosSayProvider(), new EdgeTtsProvider()];

  for (const p of candidates) {
    if (await p.isAvailable()) return p;
  }
  const tried = candidates.map((c) => c.name).join(" / ");
  throw new Error(`没有可用的 TTS provider（尝试过: ${tried}）。检查 ~/omnivoice-env、macOS say 或 pip install edge-tts`);
}

/** ffprobe 探测音频时长（秒） */
export async function probeDurationSec(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number.parseFloat(stdout.trim());
}

/** 合成整段解说并返回文件与时长。cfg 支持引擎选择与 OmniVoice 音色。 */
export async function synthesizeVoiceover(
  text: string,
  voice: Voice,
  outFile: string,
  pref: EnginePref = "auto",
  timbre?: string
): Promise<TtsResult> {
  const provider = await resolveProvider(pref, timbre);
  await provider.synthesize(text, voice, outFile);
  const durationSec = await probeDurationSec(outFile);
  return { file: outFile, durationSec, provider: provider.name };
}

/** 便捷重载：直接传 VoiceConfig */
export async function synthesizeVoiceoverCfg(
  text: string,
  cfg: VoiceConfig | undefined,
  outFile: string
): Promise<TtsResult> {
  const vc = cfg ?? { voice: "zh-female-1" as Voice, engine: "auto" as EnginePref };
  return synthesizeVoiceover(text, vc.voice, outFile, vc.engine, vc.timbre);
}

/** 新一代多引擎入口：按 voiceName 前缀分发（与 MoneyPrinterTurbo 命名一致）。
 *  omnivoice 可通过 options.timbre 指定音色词表。 */
export async function synthesizeByVoiceName(
  text: string,
  voiceName: string,
  outFile: string,
  options: { rate?: number; timbre?: string; sayVoice?: Voice } = {}
): Promise<TtsResult> {
  const { engine, voice } = parseVoiceName(voiceName);
  await mkdir(path.dirname(outFile), { recursive: true });

  if (engine === "omnivoice") {
    const provider = new OmnivoiceProvider(options.timbre);
    await provider.synthesize(text, "zh-female-1", outFile);
  } else if (engine === "say") {
    const provider = new MacosSayProvider();
    await provider.synthesize(text, (options.sayVoice ?? "zh-female-1") as Voice, outFile);
  } else {
    const def = ENGINES[engine];
    if (!def) throw new Error(`未知 TTS 引擎: ${engine}（可用: ${Object.keys(ENGINES).join(", ")}）`);
    if (def.available && !(await def.available())) {
      throw new Error(`引擎 ${engine} 当前不可用（检查依赖安装/服务是否启动）`);
    }
    await def.synth({ text, voiceName: voice, outFile, rate: options.rate });
  }
  const durationSec = await probeDurationSec(outFile);
  return { file: outFile, durationSec, provider: engine };
}

/** 引擎清单（设置页渲染用） */
export function engineCatalog() {
  return Object.entries(ENGINES)
    .filter(([id]) => id !== "omnivoice" && id !== "say")
    .map(([id, def]) => ({
      id,
      label: def.label,
      needsKey: def.needsKey,
      selfHosted: !!def.selfHosted,
      free: !!def.free,
      voices: def.voices,
      fields: def.fields ?? [],
    }));
}

/** 冒烟：生成临时语音并删除 */
export async function smokeTest(pref: EnginePref = "auto"): Promise<TtsResult> {
  const tmp = path.join(os.tmpdir(), `data-news-tts-smoke-${Date.now()}.mp3`);
  try {
    return await synthesizeVoiceover("测试语音合成。", "zh-female-1", tmp, pref);
  } finally {
    await rm(tmp, { force: true });
  }
}
