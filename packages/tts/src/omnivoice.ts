/** OmniVoice 本地 TTS 桥（Python 子进程，Apple Silicon MPS 加速）。
 *  迁移自 VoiceStudio 项目验证过的方案：
 *  - venv: ~/omnivoice-env（python 3.11 + omnivoice + torch 2.8.0，torch 2.14 MPS 卡死勿升级）
 *  - 模型: k2-fsa/OmniVoice（~2.4GB，HF 缓存）
 *  - 输出: 24kHz wav → ffmpeg 转 mp3 + 首尾静音裁剪 + 响度归一
 *  - instruct 只认固定词表（男/女、年龄段、音调），中文用全角逗号分隔，不可中英混用
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TtsProvider } from "./index.js";
import type { OmniVoiceTimbre } from "@data-news/shared";

const run = promisify(execFile);

const VENV_PYTHON = process.env.OMNIVOICE_PYTHON ?? path.join(process.env.HOME ?? "", "omnivoice-env", "bin", "python");
const MODEL_ID = "k2-fsa/OmniVoice";

const GEN_SCRIPT = `
import sys, json
from omnivoice import OmniVoice
import soundfile as sf
import torch

text, instruct, out_wav = sys.argv[1], sys.argv[2], sys.argv[3]
model = OmniVoice.from_pretrained("${MODEL_ID}", device_map="mps", dtype=torch.float16)
kwargs = {"text": text}
if instruct:
    kwargs["instruct"] = instruct
audio = model.generate(**kwargs)
sf.write(out_wav, audio[0], 24000)
print("OK")
`;

export class OmnivoiceProvider implements TtsProvider {
  readonly name = "omnivoice";
  private timbre: string | undefined;

  constructor(timbre?: string) {
    this.timbre = timbre;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await access(VENV_PYTHON, constants.X_OK);
      await run(VENV_PYTHON, ["-c", "import omnivoice, torch; print('ok')"], { timeout: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  async synthesize(text: string, _voice: Parameters<TtsProvider["synthesize"]>[1], outFile: string): Promise<void> {
    const dir = path.dirname(outFile);
    if (dir && dir !== "." && dir !== "/") await mkdir(dir, { recursive: true });
    const tmp = await mkdtemp(path.join(tmpdir(), "omni-"));
    const wavFile = path.join(tmp, "out.wav");
    const scriptFile = path.join(tmp, "gen.py");
    try {
      await writeFile(scriptFile, GEN_SCRIPT, "utf8");
      // OmniVoice 单次生成 3s 语音约 8.5s（MPS）；长文本按时长放大超时
      const timeoutMs = Math.min(Math.max(text.length * 6000, 120_000), 600_000);
      const { stdout } = await run(
        VENV_PYTHON,
        [scriptFile, text, this.timbre ?? "", wavFile],
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
      );
      if (!stdout.includes("OK")) throw new Error(`OmniVoice 生成失败: ${stdout.slice(0, 200)}`);
      // wav → mp3（与 say/edge provider 相同的后处理链）
      await run("ffmpeg", [
        "-y", "-v", "error",
        "-i", wavFile,
        "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-16:TP=-1.5",
        "-codec:a", "libmp3lame", "-q:a", "4",
        outFile,
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
