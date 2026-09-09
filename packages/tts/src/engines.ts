/**
 * 多引擎 TTS 基础设施：voiceName 前缀分发（与 MoneyPrinterTurbo 命名保持一致）。
 *
 * voiceName 约定：
 *   azure-v1:zh-CN-XiaoxiaoNeural        Edge TTS（免费，无需 Key）
 *   azure-v2:zh-CN-XiaoxiaoNeural        Azure Speech（需 speech_key + region）
 *   siliconflow:FunAudioLLM/CosyVoice2-0.5B:alex
 *   gemini:Kore                           （需 gemini_api_key）
 *   mimo:mimo-v2.5-tts                    （OpenAI 兼容 chat.completions audio）
 *   minimax:male-qn-qingse               （t2a_v2，需 key；site global|cn）
 *   elevenlabs:{voice_id}                 （需 xi-api-key）
 *   chatterbox:{voice}                    自托管 OpenAI 兼容 /audio/speech
 *   kokoro:{voice}                        自托管 OpenAI 兼容 /audio/speech
 *   fish_audio:{reference_id}             （需 key；model 走 header）
 *   omnivoice                             本地 OmniVoice（可选 timbre）
 *   say:zh-female-1                       macOS say
 *   no-voice                              静音音轨
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadSettings, engineSettings } from "@data-news/settings";

const run = promisify(execFile);

export interface TtsResult {
  file: string;
  durationSec: number;
  provider: string;
}

export interface SynthContext {
  text: string;
  voiceName: string;
  outFile: string;
  rate?: number;
}

type SynthFn = (ctx: SynthContext) => Promise<void>;

export interface EngineDef {
  id: string;
  label: string;
  /** 是否需要 API key */
  needsKey: boolean;
  /** 自托管（本地 OpenAI 兼容服务） */
  selfHosted?: boolean;
  /** 免费云（无需 key） */
  free?: boolean;
  /** 音色列表（静态或说明） */
  voices: string[];
  /** 设置页附加字段 */
  fields?: { key: string; label: string; placeholder?: string }[];
  synth: SynthFn;
  available?: () => Promise<boolean>;
}

// ---------- 通用后处理：静音裁剪 + 响度归一 ----------
export async function normalizeAudio(input: string, output: string): Promise<void> {
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", input,
    "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-16:TP=-1.5",
    "-codec:a", "libmp3lame", "-q:a", "4",
    output,
  ]);
}

async function postJsonAudio(url: string, headers: Record<string, string>, payload: unknown, outFile: string, provider: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const bodyText = (await res.text()).slice(0, 300);
    throw new Error(`${provider} HTTP ${res.status}: ${bodyText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 512) throw new Error(`${provider} 返回音频过小 (${buf.length}B)`);
  const tmp = path.join(path.dirname(outFile), `.${provider}-${Date.now()}.raw`);
  await writeFile(tmp, buf);
  await normalizeAudio(tmp, outFile);
  await rm(tmp, { force: true });
}

// ---------- 各引擎实现 ----------

/** Edge TTS（MoneyPrinterTurbo: azure_tts_v1）——免费，走 edge-tts CLI */
const azureV1: EngineDef = {
  id: "azure-v1",
  label: "Azure TTS V1 (Edge TTS)",
  needsKey: false,
  free: true,
  voices: ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-XiaoyiNeural", "zh-CN-YunjianNeural", "en-US-JennyNeural", "en-US-GuyNeural"],
  available: async () => {
    try { await run("edge-tts", ["--list-voices"]); return true; } catch { return false; }
  },
  synth: async ({ text, voiceName, outFile }) => {
    const voice = voiceName || "zh-CN-XiaoxiaoNeural";
    const tmp = path.join(os.tmpdir(), `dn-edge-${Date.now()}.mp3`);
    try {
      await run("edge-tts", ["--voice", voice, "--text", text, "--write-media", tmp], { timeout: 120_000 });
      await normalizeAudio(tmp, outFile);
    } finally {
      await rm(tmp, { force: true });
    }
  },
};

/** Azure Speech V2（REST SSML，免 SDK） */
const azureV2: EngineDef = {
  id: "azure-v2",
  label: "Azure TTS V2",
  needsKey: true,
  voices: ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-YunyeNeural", "en-US-AriaNeural"],
  fields: [{ key: "region", label: "区域", placeholder: "eastasia / eastus ..." }],
  synth: async ({ text, voiceName, outFile }) => {
    const cfg = await engineSettings("azure-v2");
    if (!cfg.apiKey || !cfg.region) throw new Error("azure-v2 需要配置 speech_key 与 region（设置页）");
    const voice = voiceName || "zh-CN-XiaoxiaoNeural";
    const ssml = `<speak version='1.0' xml:lang='zh-CN'><voice name='${voice}'><prosody rate='+0%'>${text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")}</prosody></voice></speak>`;
    // Azure TTS 用 SSML POST（content-type application/ssml+xml）
    const res = await fetch(`https://${cfg.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": cfg.apiKey,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "dataNews",
      },
      body: ssml,
    });
    if (!res.ok) throw new Error(`azure-v2 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const tmp = path.join(os.tmpdir(), `dn-az2-${Date.now()}.mp3`);
    await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    await normalizeAudio(tmp, outFile);
    await rm(tmp, { force: true });
  },
};

/** OpenAI 兼容 /audio/speech 通用引擎（siliconflow / chatterbox / kokoro 共用） */
function openaiCompatEngine(
  id: string,
  label: string,
  defaults: { baseUrl?: string; model?: string; voices: string[]; needsKey: boolean; selfHosted?: boolean; fields?: EngineDef["fields"] }
): EngineDef {
  return {
    id,
    label,
    needsKey: defaults.needsKey,
    selfHosted: defaults.selfHosted,
    voices: defaults.voices,
    fields: defaults.fields ?? [
      { key: "baseUrl", label: "Base URL", placeholder: defaults.baseUrl ?? "http://127.0.0.1:8080/v1" },
      { key: "model", label: "Model", placeholder: defaults.model ?? "" },
    ],
    synth: async ({ text, voiceName, outFile, rate }) => {
      const cfg = await engineSettings(id);
      const baseUrl = (cfg.baseUrl || defaults.baseUrl || "").replace(/\/$/, "");
      if (!baseUrl) throw new Error(`${id} 需要配置 Base URL（设置页）`);
      if (defaults.needsKey && !cfg.apiKey) throw new Error(`${id} 需要配置 API Key（设置页）`);
      await postJsonAudio(
        `${baseUrl}/audio/speech`,
        cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
        {
          model: cfg.model || defaults.model || "tts-1",
          input: text,
          voice: voiceName || "default",
          response_format: "mp3",
          speed: Math.max(0.25, Math.min(4.0, rate ?? 1.0)),
        },
        outFile,
        id
      );
    },
  };
}

const siliconflow: EngineDef = {
  ...openaiCompatEngine("siliconflow", "SiliconFlow（CosyVoice2）", {
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "FunAudioLLM/CosyVoice2-0.5B",
    needsKey: true,
    voices: ["FunAudioLLM/CosyVoice2-0.5B:alex", "FunAudioLLM/CosyVoice2-0.5B:anna", "FunAudioLLM/CosyVoice2-0.5B:bella"],
  }),
  synth: async ({ text, voiceName, outFile, rate }) => {
    const cfg = await engineSettings("siliconflow");
    if (!cfg.apiKey) throw new Error("siliconflow 需要配置 API Key（设置页）");
    await postJsonAudio(
      "https://api.siliconflow.cn/v1/audio/speech",
      { Authorization: `Bearer ${cfg.apiKey}` },
      {
        model: cfg.model || "FunAudioLLM/CosyVoice2-0.5B",
        input: text,
        voice: voiceName || "FunAudioLLM/CosyVoice2-0.5B:alex",
        response_format: "mp3",
        sample_rate: 32000,
        stream: false,
        speed: Math.max(0.25, Math.min(4.0, rate ?? 1.0)),
        gain: 0,
      },
      outFile,
      "siliconflow"
    );
  },
};

const chatterbox = openaiCompatEngine("chatterbox", "Chatterbox（自托管·声音克隆）", {
  baseUrl: "http://127.0.0.1:4123/v1",
  needsKey: false,
  selfHosted: true,
  voices: ["default"],
});

const kokoro = openaiCompatEngine("kokoro", "Kokoro-82M（自托管）", {
  baseUrl: "http://127.0.0.1:8880/v1",
  model: "kokoro",
  needsKey: false,
  selfHosted: true,
  voices: ["af_heart", "af_bella", "am_adam", "bm_george", "bf_emma"],
});

const mimo: EngineDef = {
  id: "mimo",
  label: "Xiaomi MiMo TTS",
  needsKey: true,
  voices: ["mimo-v2.5-tts"],
  fields: [
    { key: "baseUrl", label: "Base URL", placeholder: "https://api.xiaomimimo.com/v1" },
    { key: "model", label: "Model", placeholder: "mimo-v2.5-tts" },
  ],
  synth: async ({ text, voiceName, outFile }) => {
    const cfg = await engineSettings("mimo");
    if (!cfg.apiKey) throw new Error("mimo 需要配置 API Key（设置页）");
    const baseUrl = (cfg.baseUrl || "https://api.xiaomimimo.com/v1").replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model || "mimo-v2.5-tts",
        messages: [
          { role: "user", content: "用自然、专业的新闻播报语调朗读。" },
          { role: "assistant", content: text },
        ],
        audio: { format: "wav", voice: voiceName || "default" },
      }),
    });
    if (!res.ok) throw new Error(`mimo HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: { message?: { audio?: { data?: string } } }[] };
    const b64 = body.choices?.[0]?.message?.audio?.data;
    if (!b64) throw new Error("mimo 未返回音频数据");
    const tmp = path.join(os.tmpdir(), `dn-mimo-${Date.now()}.wav`);
    await writeFile(tmp, Buffer.from(b64, "base64"));
    await normalizeAudio(tmp, outFile);
    await rm(tmp, { force: true });
  },
};

const minimax: EngineDef = {
  id: "minimax",
  label: "MiniMax TTS",
  needsKey: true,
  voices: ["male-qn-qingse", "female-shaonv", "female-yujie", "male-qn-jingying"],
  fields: [{ key: "site", label: "站点", placeholder: "global 或 cn（默认 global）" }],
  synth: async ({ text, voiceName, outFile }) => {
    const cfg = await engineSettings("minimax");
    if (!cfg.apiKey) throw new Error("minimax 需要配置 API Key（设置页）");
    const url = cfg.site === "cn" ? "https://api.minimaxi.com/v1/t2a_v2" : "https://api.minimax.io/v1/t2a_v2";
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model || "speech-2.5-hd-preview",
        text,
        stream: false,
        language_boost: "auto",
        output_format: "hex",
        voice_setting: { voice_id: voiceName || "male-qn-qingse", speed: 1.0, vol: 1.0, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      }),
    });
    if (!res.ok) throw new Error(`minimax HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: { audio?: string }; base_resp?: { status_code?: number } };
    const hex = body.data?.audio;
    if (!hex) throw new Error(`minimax 未返回音频: ${JSON.stringify(body.base_resp ?? {}).slice(0, 150)}`);
    const tmp = path.join(os.tmpdir(), `dn-mm-${Date.now()}.mp3`);
    await writeFile(tmp, Buffer.from(hex, "hex"));
    await normalizeAudio(tmp, outFile);
    await rm(tmp, { force: true });
  },
};

const elevenlabs: EngineDef = {
  id: "elevenlabs",
  label: "ElevenLabs",
  needsKey: true,
  voices: ["（设置后可填任意 voice_id）"],
  synth: async ({ text, voiceName, outFile }) => {
    const cfg = await engineSettings("elevenlabs");
    if (!cfg.apiKey) throw new Error("elevenlabs 需要配置 API Key（设置页）");
    const voiceId = voiceName || "21m00Tcm4TlvDq8ikWAM";
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": cfg.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: cfg.model || "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
      }),
    });
    if (!res.ok) throw new Error(`elevenlabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const tmp = path.join(os.tmpdir(), `dn-el-${Date.now()}.mp3`);
    await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    await normalizeAudio(tmp, outFile);
    await rm(tmp, { force: true });
  },
};

const fishAudio: EngineDef = {
  id: "fish_audio",
  label: "Fish Audio",
  needsKey: true,
  voices: ["（填 reference_id，留空用默认音色）"],
  synth: async ({ text, voiceName, outFile }) => {
    const cfg = await engineSettings("fish_audio");
    if (!cfg.apiKey) throw new Error("fish_audio 需要配置 API Key（设置页）");
    const res = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        model: cfg.model || "s1",
      },
      body: JSON.stringify({
        text,
        format: "mp3",
        prosody: { speed: 1.0, volume: 0 },
        ...(voiceName ? { reference_id: voiceName } : {}),
      }),
    });
    if (!res.ok) throw new Error(`fish_audio HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const tmp = path.join(os.tmpdir(), `dn-fish-${Date.now()}.mp3`);
    await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    await normalizeAudio(tmp, outFile);
    await rm(tmp, { force: true });
  },
};

const gemini: EngineDef = {
  id: "gemini",
  label: "Gemini TTS",
  needsKey: true,
  voices: ["Kore", "Puck", "Charon", "Fenrir", "Aoede"],
  synth: async ({ text, voiceName, outFile }) => {
    const cfg = await engineSettings("gemini");
    if (!cfg.apiKey) throw new Error("gemini 需要配置 API Key（设置页）");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${cfg.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName || "Kore" } } },
          },
        }),
      }
    );
    if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
    };
    const inline = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!inline?.data) throw new Error("gemini 未返回音频");
    // gemini 输出 24kHz 16bit PCM（带 mime 头），需要 wav 容器
    const sampleRate = Number(inline.mimeType?.match(/rate=(\d+)/)?.[1] ?? 24000);
    const pcm = Buffer.from(inline.data, "base64");
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
    header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    const tmp = path.join(os.tmpdir(), `dn-gem-${Date.now()}.wav`);
    await writeFile(tmp, Buffer.concat([header, pcm]));
    await normalizeAudio(tmp, outFile);
    await rm(tmp, { force: true });
  },
};

const noVoice: EngineDef = {
  id: "no-voice",
  label: "无配音（静音）",
  needsKey: false,
  voices: [],
  synth: async ({ text, outFile }) => {
    // 生成与文本长度匹配的静音（约 0.18s/字），直接编码 mp3。
    // 注意：不能走 normalizeAudio——首尾静音裁剪会把纯静音裁成 0 秒空文件。
    const dur = Math.max(2, text.length * 0.18);
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", dur.toFixed(2),
      "-codec:a", "libmp3lame", "-q:a", "4", outFile]);
  },
};

/** 引擎注册表（id 与 MoneyPrinterTurbo 命名一致） */
/** say 与 omnivoice 由 index.ts 注册（依赖包内 Provider 类） */
export const ENGINES: Record<string, EngineDef> = {
  "azure-v1": azureV1,
  "azure-v2": azureV2,
  siliconflow,
  gemini,
  mimo,
  minimax,
  elevenlabs,
  chatterbox,
  kokoro,
  fish_audio: fishAudio,
  "no-voice": noVoice,
};
export function registerEngine(id: string, def: EngineDef) {
  ENGINES[id] = def;
}

export function parseVoiceName(voiceName: string): { engine: string; voice: string } {
  const idx = voiceName.indexOf(":");
  if (idx === -1) return { engine: voiceName, voice: "" };
  return { engine: voiceName.slice(0, idx), voice: voiceName.slice(idx + 1) };
}
