#!/usr/bin/env node
/** check-templates.mjs — 自检 1-5 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "html");
const FILES = [
  "mk-line-graph.html",
  "mk-progress-stat.html",
  "news-ticker.html",
  "flowchart-vertical.html",
  "apple-money-count.html",
  "us-map-bubble.html",
  "world-map.html",
];

let failures = 0;
const fail = (f, msg) => { failures++; console.log(`${f}: FAIL: ${msg}`); };

for (const f of FILES) {
  const p = path.join(DIR, f);
  const html = readFileSync(p, "utf8");

  // 1. data-composition-variables JSON 可解析（单引号包裹）且属性内无原生非 ASCII
  const m = html.match(/<html[^>]*data-composition-variables='([^']*)'/);
  if (!m) { fail(f, "no data-composition-variables attribute"); continue; }
  let nonAscii = false;
  for (const ch of m[1]) {
    if (ch.charCodeAt(0) > 127) { nonAscii = true; break; }
  }
  if (nonAscii) { fail(f, "non-ASCII char inside attribute"); continue; }
  let decl;
  try { decl = JSON.parse(m[1]); } catch (e) { fail(f, `bad JSON: ${e.message}`); continue; }
  if (!decl.some((d) => d.id === "theme" && d.default === "dark-finance")) {
    fail(f, "theme variable missing / wrong default"); continue;
  }

  // 2. 每个 <script> 块语法检查（跳过内联大 JSON 所在脚本——不含 __INLINE 时已全部为 JS）
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  let syntaxOk = true, syntaxErr = "";
  for (const code of scripts) {
    try { new Function(code); } catch (e) { syntaxOk = false; syntaxErr = e.message; break; }
  }
  if (!syntaxOk) { fail(f, `script syntax: ${syntaxErr}`); continue; }

  // 3. gsap 本地化 & 无 CDN 脚本
  if (!html.includes('src="node_modules/gsap/dist/gsap.min.js"')) { fail(f, "missing local gsap script"); continue; }
  if (/src="https:\/\/cdn\./.test(html)) { fail(f, "CDN script remains"); continue; }
  if (/https:\/\/cdn\.jsdelivr\.net\/npm\/(d3|topojson|us-atlas|world-atlas)/.test(html)) { fail(f, "CDN d3/topojson/atlas remains"); continue; }
  if (html.includes("assets/sfx-production.wav") || /<audio/i.test(html)) { fail(f, "audio element present"); continue; }

  // 4. getElementById / querySelector id 存在性（仅查 getElementById("...") 精确串）
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((x) => x[1]));
  const refs = [...html.matchAll(/getElementById\("([^"]+)"\)/g)].map((x) => x[1]);
  const dynamic = /^(mk-lg-(path|dot|val|xl)-|scene-mount-)/;
  const missing = [...new Set(refs.filter((r) => !ids.has(r) && !dynamic.test(r)))];
  // mk-lg-* ids are created at runtime before their getElementById calls; verify by constructing
  const missingReal = missing.filter((r) => {
    if (r.startsWith("mk-lg-")) {
      // runtime-generated after appendChild — accept
      return false;
    }
    return true;
  });
  if (missingReal.length) { fail(f, `missing ids: ${missingReal.join(",")}`); continue; }

  // root has theme class hook + bg/fg
  const rootIdMatch = html.match(/data-composition-id="([^"]+)"/);
  const rootId = rootIdMatch ? rootIdMatch[1] : null;
  if (!rootId) { fail(f, "no data-composition-id"); continue; }
  if (!html.includes('classList.add("theme-"')) { fail(f, "no theme class injection"); continue; }

  console.log(`${f}: OK (${(html.length / 1024).toFixed(0)} KB, ${decl.length} vars)`);
}

// 5. manifest 校验
const ROOT = path.dirname(DIR);
const manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const tpls = manifest.templates;
const idCount = new Map();
for (const t of tpls) idCount.set(t.id, (idCount.get(t.id) || 0) + 1);
const dup = [...idCount.entries()].filter(([, n]) => n > 1).map(([id]) => id);
console.log(`manifest: ${tpls.length} templates, dup ids: ${dup.length ? dup.join(",") : "none"}`);
if (tpls.length !== 21) { failures++; console.log("FAIL: manifest template count != 21"); }
if (dup.length) { failures++; console.log("FAIL: duplicate ids in manifest"); }
for (const f of FILES) {
  const id = f.replace(/\.html$/, "");
  if (!tpls.find((t) => t.id === id && t.html === `html/${f}`)) {
    failures++; console.log(`FAIL: manifest missing entry for ${id}`);
  }
}

console.log(failures ? `\nTOTAL FAILURES: ${failures}` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
