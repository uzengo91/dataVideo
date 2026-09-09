import { describe, it, expect } from "vitest";
import { ingestCsv, tableToLlmSummary } from "./ingest.js";

const CSV = `月份,营收(万元),毛利率
7月,"1,200",42%
8月,"1,350",44%
9月,1500,45%`;

describe("ingestCsv", () => {
  it("解析带引号数字/百分号/千分位", () => {
    const t = ingestCsv(CSV);
    expect(t.columns).toHaveLength(3);
    expect(t.columns[1].type).toBe("number");
    expect(t.rows[0]["营收(万元)"]).toBe(1200);
    expect(t.rows[2]["营收(万元)"]).toBe(1500);
    expect(t.rowCount).toBe(3);
  });

  it("日期列识别", () => {
    const t = ingestCsv("date,v\n2024-01,5\n2024-02,6");
    expect(t.columns[0].type).toBe("date");
  });

  it("拒绝空 CSV", () => {
    expect(() => ingestCsv("")).toThrow();
    expect(() => ingestCsv("a,b\n")).toThrow();
  });

  it("llm 摘要包含列与行", () => {
    const s = tableToLlmSummary(ingestCsv(CSV));
    expect(s).toContain("营收(万元)(number");
    expect(s).toContain("9月");
  });
});
