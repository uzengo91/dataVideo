/**
 * 设置中心：持久化 TTS/LLM 配置到 <dataDir>/settings.json。
 * 环境变量作为缺省兜底（ARK_API_KEY 等），settings 文件优先。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface TtsEngineSettings {
  /** 引擎是否在音色列表中展示 */
  enabled?: boolean;
  apiKey?: string;
  /** 自定义 base url（OpenAI 兼容引擎/自托管） */
  baseUrl?: string;
  model?: string;
  /** azure v2 区域 */
  region?: string;
  /** minimax 站点：global | cn */
  site?: "global" | "cn";
}

export interface LlmSettings {
  /** openai | claude */
  provider: "openai" | "claude";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface AppSettings {
  tts: Record<string, TtsEngineSettings>;
  llm: LlmSettings;
}

const DEFAULTS: AppSettings = {
  tts: {},
  llm: { provider: "openai" },
};

let dataDir = process.env.JOB_DATA_DIR
  ? path.resolve(process.env.JOB_DATA_DIR)
  : path.resolve(process.cwd(), "data");
const settingsFile = () => path.join(dataDir, "settings.json");

export function setDataDir(dir: string) {
  dataDir = path.resolve(dir);
}

let cache: AppSettings | undefined;

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache;
  try {
    const raw = await readFile(settingsFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    cache = {
      tts: { ...DEFAULTS.tts, ...parsed.tts },
      llm: { ...DEFAULTS.llm, ...parsed.llm },
    };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  // 环境变量兜底
  if (!cache.llm.apiKey && process.env.ARK_API_KEY) {
    cache.llm.apiKey = process.env.ARK_API_KEY;
    cache.llm.baseUrl ||= process.env.ARK_BASE_URL;
    cache.llm.model ||= process.env.ARK_MODEL;
  }
  return cache;
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const cur = await loadSettings();
  const next: AppSettings = {
    tts: { ...cur.tts, ...(patch.tts ?? {}) },
    llm: { ...cur.llm, ...(patch.llm ?? {}) },
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(settingsFile(), JSON.stringify(next, null, 2), "utf8");
  cache = next;
  return next;
}

/** 读取指定引擎配置（合并 env 兜底） */
export async function engineSettings(engine: string): Promise<TtsEngineSettings> {
  const s = await loadSettings();
  const e = s.tts[engine] ?? {};
  const envKey = `${engine.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  return {
    ...e,
    apiKey: e.apiKey || process.env[envKey] || "",
  };
}
