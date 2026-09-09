/**
 * M0 验收 demo：CSV 文本 → LLM 场景脚本 JSON → VO.mp3
 * 用法：pnpm --filter @data-news/pipeline demo [csv文件路径]
 * 无参数时使用内置示例数据。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ingestCsv } from "./ingest.js";
import { planScript } from "./script-planner.js";
import { synthesizeVoiceover } from "@data-news/tts";

const SAMPLE_CSV = `月份,营收(万元),同比增长,毛利率
1月,1180,12%,41.2
2月,1245,15%,42.0
3月,1390,18%,42.8
4月,1452,16%,43.1
5月,1560,21%,43.6
6月,1712,23%,44.2`;

async function main() {
  const csvPath = process.argv[2];
  const csvText = csvPath ? await readFile(csvPath, "utf8") : SAMPLE_CSV;
  const outDir = path.resolve("data/demo");
  await mkdir(outDir, { recursive: true });

  console.log("[1/3] 解析 CSV…");
  const table = ingestCsv(csvText);
  console.log(`  列: ${table.columns.map((c) => `${c.name}(${c.type})`).join(", ")}, ${table.rowCount} 行`);

  console.log("[2/3] LLM 生成脚本…");
  const t0 = Date.now();
  const script = await planScript(table, {});
  console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，标题「${script.title}」，${script.scenes.length} 个场景：`);
  for (const [i, s] of script.scenes.entries()) {
    console.log(`  [${i}] ${s.template} — ${s.headline} | ${s.narration.slice(0, 40)}…`);
  }
  const scriptFile = path.join(outDir, "script.json");
  await writeFile(scriptFile, JSON.stringify(script, null, 2), "utf8");
  console.log(`  → ${scriptFile}`);

  console.log("[3/3] TTS 合成解说…");
  const narration = script.scenes.map((s) => s.narration).join("。");
  const vo = await synthesizeVoiceover(narration, script.voice, path.join(outDir, "vo.mp3"));
  console.log(`  provider=${vo.provider}, 时长 ${vo.durationSec.toFixed(1)}s → ${vo.file}`);

  console.log("\nM0 验收 ✅  CSV → 脚本JSON → VO.mp3 全链路打通");
}

main().catch((e) => {
  console.error("M0 demo 失败:", e.message ?? e);
  process.exit(1);
});
