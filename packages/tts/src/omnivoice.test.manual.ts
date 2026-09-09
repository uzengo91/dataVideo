/** OmniVoice provider 冒烟：走完整 synthesize 链路（真实模型，MPS）。约 30-60s。
 *  用法：npx tsx src/omnivoice.test.manual.ts */
import { OmnivoiceProvider } from "./omnivoice.js";
import { probeDurationSec } from "./index.js";
import { rm } from "node:fs/promises";

const p = new OmnivoiceProvider("女，青年，中音调");
console.log("available:", await p.isAvailable());
if (!p.isAvailable.call(p)) process.exit(1);
const out = "/tmp/omni-smoke.mp3";
await p.synthesize("这是 OmniVoice 本地语音合成测试，数字不会说谎：营收增长百分之二十三。", "zh-female-1", out);
console.log("duration:", (await probeDurationSec(out)).toFixed(2) + "s", "→", out);
await rm(out, { force: true });
console.log("SMOKE PASS");
