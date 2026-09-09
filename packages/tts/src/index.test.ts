import { describe, it, expect } from "vitest";
import { probeDurationSec } from "./index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const run = promisify(execFile);

describe("probeDurationSec", () => {
  it("探测 ffmpeg 合成音频的时长", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tts-test-"));
    try {
      const file = path.join(dir, "t.mp3");
      await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", file]);
      const d = await probeDurationSec(file);
      expect(d).toBeGreaterThan(1.8);
      expect(d).toBeLessThan(2.5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
