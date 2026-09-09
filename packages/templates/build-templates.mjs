#!/usr/bin/env node
/**
 * build-templates.mjs — 把 __VARS__ / __INLINE_*__ 占位替换为真实内容：
 *  - __VARS__            → data-composition-variables JSON（ensure_ascii，\uXXXX 转义）
 *  - __INLINE_D3__       → d3@7 minified 源码
 *  - __INLINE_TOPOJSON__ → topojson-client@3.1.0 minified 源码
 *  - __INLINE_US_TOPO__    → us-atlas states-10m.json（JSON 字面量）
 *  - __INLINE_WORLD_TOPO__ → world-atlas countries-110m.json（JSON 字面量）
 * 用法：node build-templates.mjs   （在 packages/templates 下运行）
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "html");
const ASSETS = "/tmp/hf-assets";

const d3 = readFileSync(path.join(ASSETS, "d3.min.js"), "utf8");
const topo = readFileSync(path.join(ASSETS, "topojson-client.min.js"), "utf8");
const usTopo = readFileSync(path.join(ASSETS, "us-states-10m.json"), "utf8");
const worldTopo = readFileSync(path.join(ASSETS, "world-countries-110m.json"), "utf8");
// safety: minified JS must not contain the closing script tag
for (const [name, src] of [["d3", d3], ["topojson", topo]]) {
  if (/<\/script/i.test(src)) throw new Error(`${name} contains </script>`);
}

const THEME_ENUM = ["dark-finance", "light-tech", "violet-trend", "warm-sunrise", "cool-mint", "ink-classic"];

/** 变量声明数组 → ensure-ascii JSON（中文全部 \uXXXX） */
function vars(decl) {
  const full = [...decl, { id: "theme", type: "string", label: "theme", default: "dark-finance", enum: THEME_ENUM }];
  return JSON.stringify(full).replace(/[\u007f-\uffff]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

const FILES = {
  "mk-line-graph.html": [
    { id: "headline", type: "string", label: "headline", default: "季度营收走势" },
    { id: "subline", type: "string", label: "subline", default: "单位：百万美元" },
    { id: "labels", type: "string", label: "labels", default: "1月,2月,3月,4月,5月,6月" },
    { id: "series1", type: "string", label: "series1", default: "12,26,22,38,44,58" },
    { id: "series2", type: "string", label: "series2", default: "8,14,18,16,28,36" },
  ],
  "mk-progress-stat.html": [
    { id: "headline", type: "string", label: "headline", default: "年度目标进度" },
    { id: "subline", type: "string", label: "subline", default: "数据截至本季度末" },
    { id: "value", type: "number", label: "value", default: 22 },
    { id: "max", type: "number", label: "max", default: 30 },
    { id: "label", type: "string", label: "label", default: "目标达成" },
    { id: "caption", type: "string", label: "caption", default: "进展顺利，离目标越来越近！" },
  ],
  "news-ticker.html": [
    {
      id: "headline",
      type: "string",
      label: "headline",
      default: "AI 视频工具从原型走向规模化生产",
    },
    { id: "subline", type: "string", label: "subline", default: "全球编辑室" },
    {
      id: "items",
      type: "string",
      label: "items",
      default:
        "创作团队上线周期缩短 38%;渲染队列 2 分钟内清空;新版目录块在产品演示中走红;编辑团队转向 HTML 优先动效体系",
    },
  ],
  "flowchart-vertical.html": [
    { id: "headline", type: "string", label: "headline", default: "决策流程" },
    { id: "subline", type: "string", label: "subline", default: "一步步拆解决策路径" },
    {
      id: "nodes",
      type: "string",
      label: "nodes",
      default: "该学编程吗？;是;不确定;从 Python 入门;先试无代码;做个个人网站;上免费入门课",
    },
  ],
  "apple-money-count.html": [
    { id: "headline", type: "string", label: "headline", default: "年度总营收" },
    { id: "subline", type: "string", label: "subline", default: "单位：美元" },
    { id: "endValue", type: "number", label: "endValue", default: 10000 },
    { id: "prefix", type: "string", label: "prefix", default: "$" },
  ],
  "us-map-bubble.html": [
    { id: "headline", type: "string", label: "headline", default: "美国城市人口 Top20" },
    { id: "subline", type: "string", label: "subline", default: "气泡大小与数值成正比" },
    {
      id: "cities",
      type: "string",
      label: "cities",
      default:
        "New York,40.7128,-74.006,8300000;Los Angeles,34.0522,-118.2437,3900000;Chicago,41.8781,-87.6298,2700000;Houston,29.7604,-95.3698,2300000;Phoenix,33.4484,-112.074,1600000;Philadelphia,39.9526,-75.1652,1600000;San Antonio,29.4241,-98.4936,1400000;San Diego,32.7157,-117.1611,1400000;Dallas,32.7767,-96.797,1300000;San Jose,37.3382,-121.8863,1000000;Austin,30.2672,-97.7431,960000;Jacksonville,30.3322,-81.6557,950000",
    },
  ],
  "world-map.html": [
    { id: "headline", type: "string", label: "headline", default: "全球人均 GDP 对比" },
    { id: "subline", type: "string", label: "subline", default: "Top5 国家人均 GDP（美元）" },
    { id: "topCodes", type: "string", label: "topCodes", default: "756,578,840,036,752" },
    { id: "topValues", type: "string", label: "topValues", default: "105669,94660,85373,65366,59324" },
  ],
};

for (const [file, decl] of Object.entries(FILES)) {
  const p = path.join(DIR, file);
  let html = readFileSync(p, "utf8");
  if (!html.includes("__VARS__") && !html.includes("__INLINE_")) {
    console.log(`${file}: no placeholders, skipped`);
    continue;
  }
  html = html.replaceAll("__VARS__", vars(decl));
  html = html.replaceAll("__INLINE_D3__", () => d3);
  html = html.replaceAll("__INLINE_TOPOJSON__", () => topo);
  html = html.replaceAll("__INLINE_US_TOPO__", () => usTopo);
  html = html.replaceAll("__INLINE_WORLD_TOPO__", () => worldTopo);
  if (/__[A-Z0-9_]+__/.test(html)) throw new Error(`${file}: leftover placeholder`);
  writeFileSync(p, html, "utf8");
  console.log(`${file}: injected (${(html.length / 1024).toFixed(0)} KB)`);
}
console.log("done");
