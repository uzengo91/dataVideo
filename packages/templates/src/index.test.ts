import { describe, it, expect } from "vitest";
import { loadManifest, getTemplate, validateSceneVars } from "./index.js";

describe("templates manifest", () => {
  it("载入并含全部 10 套模板", async () => {
    const m = await loadManifest();
    expect(m.templates.length).toBeGreaterThanOrEqual(14);
    expect(m.templates.map((t) => t.id)).toContain("kpi-headline");
  });

  it("getTemplate 返回指定模板", async () => {
    const t = await getTemplate("kpi-headline");
    expect(t.name).toContain("KPI");
    expect(t.duration.min).toBeGreaterThan(0);
  });

  it("未知模板抛错", async () => {
    await expect(getTemplate("nope")).rejects.toThrow("未知模板");
  });
});

describe("validateSceneVars", () => {
  it("合法变量通过", async () => {
    const t = await getTemplate("kpi-headline");
    const errs = validateSceneVars(t, {
      headline: "Q3 营收",
      kpi: "¥4.28亿",
      delta: "+23%",
      deltaDir: "up",
      theme: "dark-finance",
    });
    expect(errs).toEqual([]);
  });

  it("缺必填/枚举错/超长被拦", async () => {
    const t = await getTemplate("kpi-headline");
    const errs = validateSceneVars(t, { kpi: "1", theme: "rainbow", headline: "x".repeat(99) });
    expect(errs.some((e) => e.includes("theme"))).toBe(true);
    expect(errs.some((e) => e.includes("超长"))).toBe(true);
  });
});
