/**
 * M1 验收 demo：CSV → 完整管线 → 含音轨 1080p60 MP4
 * 用法：pnpm --filter @data-news/pipeline run demo:video [csv文件]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runPipeline } from "./orchestrator.js";
import type { Quality } from "@data-news/shared";

const SAMPLE_CSV = `月份,营收(万元),同比增长,毛利率
1月,1180,12%,41.2
2月,1245,15%,42.0
3月,1390,18%,42.8
4月,1452,16%,43.1
5月,1560,21%,43.6
6月,1712,23%,44.2`;

async function main() {
  const csvPath = process.argv[2];
  const csv = csvPath ? await readFile(csvPath, "utf8") : SAMPLE_CSV;
  const jobId = randomUUID().slice(0, 8);
  const quality = (process.env.RENDER_QUALITY as Quality) || "draft";
  const templates = process.env.DEMO_TEMPLATES?.split(",").map((s) => s.trim()).filter(Boolean);

  console.log(`[pipeline] job=${jobId} quality=${quality}${templates ? ` templates=[${templates}]` : ""}`);
  const result = await runPipeline(
    jobId,
    { csv, quality, templates },
    {
      onEvent: (e) => console.log(`  [${e.status}] ${e.progress}% ${e.message}`),
    }
  );
  console.log(
    `\nM1 验收 ✅ 成片: ${result.videoFile}\n  ${result.videoBytes} bytes, 时长 ${result.totalDurationSec.toFixed(
      1
    )}s, 总耗时 ${(result.elapsedMs / 1000).toFixed(1)}s\n  场景: ${result.script.scenes
      .map((s) => s.template)
      .join(" → ")}`
  );
}

main().catch((e) => {
  console.error("M1 demo 失败:", e.message ?? e);
  process.exit(1);
});
