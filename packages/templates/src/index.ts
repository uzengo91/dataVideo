import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ManifestSchema = z.object({
  templates: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      sceneHint: z.string(),
      html: z.string(),
      duration: z.object({ min: z.number(), max: z.number() }),
      variables: z.record(
        z.string(),
        z.object({
          type: z.enum(["string", "number", "color", "enum", "boolean"]),
          required: z.boolean().optional(),
          maxLen: z.number().optional(),
          enum: z.array(z.string()).optional(),
          note: z.string().optional(),
        })
      ),
    })
  ),
});

export type TemplateManifest = z.infer<typeof ManifestSchema>;
export type TemplateEntry = TemplateManifest["templates"][number];

// pkg 快照环境（CJS）：import.meta.url 为 undefined，必须走 __filename
const moduleUrl = typeof import.meta?.url === "string" ? import.meta.url : undefined;
const __dirname = path.dirname(
  moduleUrl
    ? fileURLToPath(moduleUrl)
    : typeof __filename !== "undefined"
      ? __filename
      : process.cwd()
);
/** 模板资产根定位顺序：包目录 → 可执行文件旁（便携发行布局） */
export const TEMPLATE_PKG_ROOT = path.resolve(__dirname, "..");
export async function resolveTemplateRoot(): Promise<string> {
  // 打包发行时 manifest 放在可执行文件旁的 resources/templates/
  // 用 existsSync（真实文件系统）：pkg 快照内 readFile 会命中虚拟 FS 报错
  const candidates = [
    path.join(path.dirname(process.execPath), "resources", "templates"), // 便携发行
    ...(process.env.TEMPLATE_ROOT ? [process.env.TEMPLATE_ROOT] : []),     // 显式指定（GUI 等）
    TEMPLATE_PKG_ROOT,                                                     // 仓库内直跑
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, "manifest.json"))) return c;
  }
  return TEMPLATE_PKG_ROOT;
}

let cached: TemplateManifest | undefined;
let cachedRoot: string | undefined;

export async function loadManifest(): Promise<TemplateManifest> {
  if (cached) return cached;
  cachedRoot = await resolveTemplateRoot();
  const raw = await readFile(path.join(cachedRoot, "manifest.json"), "utf8");
  cached = ManifestSchema.parse(JSON.parse(raw));
  return cached;
}

export async function getTemplate(id: string): Promise<TemplateEntry> {
  const m = await loadManifest();
  const t = m.templates.find((t) => t.id === id);
  if (!t) throw new Error(`未知模板: ${id}（可用: ${m.templates.map((t) => t.id).join(", ")}）`);
  return t;
}

export async function readTemplateHtml(id: string): Promise<string> {
  await loadManifest(); // 确保 cachedRoot 就绪
  const t = await getTemplate(id);
  const root = cachedRoot ?? TEMPLATE_PKG_ROOT;
  return readFile(path.join(root, t.html), "utf8");
}

/** 按 manifest 校验场景变量（LLM 产出的 data 字段） */
export function validateSceneVars(tpl: TemplateEntry, data: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, spec] of Object.entries(tpl.variables)) {
    const val = data[key];
    if (val === undefined || val === "") {
      if (spec.required) errors.push(`缺少必填变量 ${key}`);
      continue;
    }
    if (spec.type === "number" && typeof val !== "number" && Number.isNaN(Number(val))) {
      errors.push(`变量 ${key} 应为数字，得到: ${val}`);
    }
    if (spec.type === "string" && typeof val !== "string" && typeof val !== "number") {
      errors.push(`变量 ${key} 应为字符串`);
    }
    if (spec.maxLen && String(val).length > spec.maxLen) {
      errors.push(`变量 ${key} 超长（${String(val).length} > ${spec.maxLen}）`);
    }
    if (spec.enum && !spec.enum.includes(String(val))) {
      errors.push(`变量 ${key} 应为 ${spec.enum.join("|")}，得到: ${val}`);
    }
  }
  return errors;
}
