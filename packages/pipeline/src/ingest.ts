import Papa from "papaparse";
import { TableSchema, type Table } from "@data-news/shared";

/** 数字字符串归一化：去货币符号/千分位/百分号/空白，失败返回原值 */
function coerceNumber(s: string): number | string {
  const cleaned = s.replace(/[,\s￥$¥€£%]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (cleaned === "" || cleaned === "-") return s;
  const n = Number(cleaned);
  return Number.isFinite(n) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(cleaned) ? n : s;
}

function looksLikeDate(s: string): boolean {
  return (
    /^\d{4}[-/年]\d{1,2}([-/月]\d{1,2}日?)?$/.test(s) ||
    /^\d{1,2}月$/.test(s) ||
    /^Q[1-4]$/i.test(s) ||
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(s)
  );
}

/** CSV 文本 → 结构化 Table（类型推断 + 采样）。解析失败抛错。 */
export function ingestCsv(csvText: string, maxRows = 200): Table {
  const parsed = Papa.parse<Record<string, string>>(csvText.trim(), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length && parsed.data.length === 0) {
    throw new Error(`CSV 解析失败: ${parsed.errors[0].message}`);
  }
  const rowsRaw = parsed.data;
  if (!rowsRaw.length) throw new Error("CSV 没有数据行");
  const headers = Object.keys(rowsRaw[0]).filter((h) => h !== "");
  if (!headers.length) throw new Error("CSV 没有有效列");

  // 类型推断：全部非空值都是数字 → number；多数像日期 → date；否则 string
  const columns = headers.map((name) => {
    const values = rowsRaw.map((r) => String(r[name] ?? "").trim()).filter((v) => v !== "");
    const sample = values[0] ?? "";
    let type: "number" | "string" | "date" = "string";
    if (values.length && values.every((v) => typeof coerceNumber(v) === "number")) {
      type = "number";
    } else if (values.filter(looksLikeDate).length >= Math.ceil(values.length * 0.6)) {
      type = "date";
    }
    return { name, type, sample };
  });

  const rows = rowsRaw.slice(0, maxRows).map((r) => {
    const out: Record<string, string | number> = {};
    for (const col of columns) {
      const raw = String(r[col.name] ?? "").trim();
      out[col.name] = col.type === "number" ? coerceNumber(raw) : raw;
    }
    return out;
  });

  return TableSchema.parse({
    columns,
    rows,
    rowCount: rowsRaw.length,
  });
}

/** 给 LLM 的紧凑数据摘要：列 schema + 全部行（行数多时采样首 40 行） */
export function tableToLlmSummary(table: Table, maxSampleRows = 40): string {
  const cols = table.columns.map((c) => `${c.name}(${c.type}, 例: ${c.sample})`).join("; ");
  const rows = table.rows.slice(0, maxSampleRows);
  const lines = rows.map((r) =>
    table.columns.map((c) => `${c.name}=${r[c.name]}`).join(", ")
  );
  const truncated =
    table.rowCount > rows.length ? `\n…（共 ${table.rowCount} 行，仅展示前 ${rows.length} 行）` : "";
  return `列: ${cols}\n数据 ${table.rowCount} 行:\n${lines.join("\n")}${truncated}`;
}
