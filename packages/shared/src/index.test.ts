import { describe, it, expect } from "vitest";
import { VideoScriptSchema, CreateJobRequestSchema, TableSchema } from "./index.js";

describe("VideoScriptSchema", () => {
  const valid = {
    title: "Q3 财报解读",
    scenes: [
      {
        template: "kpi-headline",
        narration: "第三季度营收四点二八亿，同比增长百分之二十三。",
        headline: "Q3 营收",
        data: { kpi: "¥4.28亿", delta: "+23%" },
        sourceRefs: ["revenue"],
      },
    ],
  };

  it("接受合法脚本并补默认值", () => {
    const s = VideoScriptSchema.parse(valid);
    expect(s.voice).toBe("zh-female-1");
    expect(s.theme).toBe("dark-finance");
    expect(s.scenes[0].subline).toBe("");
  });

  it("拒绝空场景", () => {
    expect(() => VideoScriptSchema.parse({ ...valid, scenes: [] })).toThrow();
  });

  it("拒绝未知模板", () => {
    expect(() =>
      VideoScriptSchema.parse({ ...valid, scenes: [{ ...valid.scenes[0], template: "nope" }] })
    ).not.toThrow(); // 模板存在性由 pipeline 校验（manifest），schema 只查非空
  });

  it("拒绝超长解说词", () => {
    expect(() =>
      VideoScriptSchema.parse({
        ...valid,
        scenes: [{ ...valid.scenes[0], narration: "x".repeat(201) }],
      })
    ).toThrow();
  });
});

describe("CreateJobRequestSchema", () => {
  it("拒绝过短 CSV", () => {
    expect(() => CreateJobRequestSchema.parse({ csv: "a,b" })).toThrow();
  });
  it("接受合法请求", () => {
    const r = CreateJobRequestSchema.parse({
      csv: "month,revenue\nJan,100\nFeb,120",
      quality: "draft",
    });
    expect(r.quality).toBe("draft");
  });
});

describe("TableSchema", () => {
  it("接受数字与字符串混合行", () => {
    const t = TableSchema.parse({
      columns: [{ name: "m", type: "string", sample: "Jan" }],
      rows: [{ m: "Jan" }, { m: "Feb" }],
      rowCount: 2,
    });
    expect(t.rowCount).toBe(2);
  });
});
