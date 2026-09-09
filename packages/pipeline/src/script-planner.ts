import type { Table, VideoScript } from "@data-news/shared";
import { VideoScriptSchema } from "@data-news/shared";
import { ArkClient } from "@data-news/llm";
import { loadManifest, getTemplate, validateSceneVars } from "@data-news/templates";
import { tableToLlmSummary } from "./ingest.js";

const SYSTEM_PROMPT = `你是资深财经短视频编导。任务：把用户给定的表格数据改编为一条 30-60 秒的数据解说短视频脚本。

铁律：
1. 数字保真：脚本中出现的每一个数字（屏幕变量与解说词）必须能在源数据中找到，或由源数据直接算出（如增速、差值）。禁止编造、四舍五入到数据中不存在的精度、或引入外部数据。
2. 每个场景 data 字段只能使用该模板 variables 里声明的变量名；值用已格式化的字符串（如 "¥4.28亿"、"+23%"）或数字（模板要求 number 时）。
3. 解说词口语化、无符号堆砌（TTS 朗读用），15-60 字；"亿/万/％" 写成汉字读音友好的形式（如 "4.28亿" 读作 "四点二八亿" 可接受）。
4. 场景数 3-6 个：开场(数字滚动或KPI) → 展开(趋势/对比/构成) → 收尾(金句)。按数据特点选择最合适的模板，不要硬凑。
5. theme 按内容选择：财经/财报用 dark-finance，科技/增长用 light-tech。

可用模板及其变量 schema：
{{TEMPLATE_DOCS}}

输出：只输出一个 JSON 对象，结构如下（不要 markdown 代码块，不要解释）：
{
  "title": "视频标题（<=40字）",
  "voice": "zh-female-1",
  "theme": "dark-finance | light-tech",
  "scenes": [
    { "template": "模板ID", "headline": "屏幕标题", "subline": "副标题", "narration": "解说词", "data": { "变量名": "值" }, "sourceRefs": ["引用的源数据列名"] }
  ]
}`;

/** 生成模板说明文档（给 system prompt 注入） */
async function templateDocs(): Promise<string> {
  const m = await loadManifest();
  return m.templates
    .map((t) => {
      const vars = Object.entries(t.variables)
        .map(([k, v]) => {
          const req = v.required ? "必填" : "可选";
          const extra = v.enum ? ` 枚举:${v.enum.join("|")}` : "";
          const note = v.note ? ` (${v.note})` : "";
          return `    - ${k}: ${v.type} ${req}${v.maxLen ? ` <=${v.maxLen}字` : ""}${extra}${note}`;
        })
        .join("\n");
      return `- ${t.id}（${t.name}）: ${t.description}\n  适用: ${t.sceneHint}\n  变量:\n${vars}`;
    })
    .join("\n");
}

export interface PlanOptions {
  titleHint?: string;
  voice?: VideoScript["voice"];
  theme?: VideoScript["theme"];
  templates?: string[];
  client?: ArkClient;
}

/** 场景变量预校验（含模板缺省回填）；返回错误列表，空数组 = 通过 */
async function validateScenes(script: VideoScript): Promise<string[]> {
  const manifest = await loadManifest();
  const errors: string[] = [];
  for (const scene of script.scenes) {
    const tpl = manifest.templates.find((t) => t.id === scene.template);
    if (!tpl) {
      errors.push(`场景「${scene.headline}」使用了未知模板 ${scene.template}`);
      continue;
    }
    // 场景级字段回填为模板变量（headline/subline/theme 对全部模板生效；多余变量被模板忽略）
    const merged: Record<string, unknown> = { ...scene.data };
    if (merged.headline === undefined || merged.headline === "") merged.headline = scene.headline;
    if ((merged.subline === undefined || merged.subline === "") && scene.subline) merged.subline = scene.subline;
    if (merged.theme === undefined) merged.theme = script.theme;

    const errs = validateSceneVars(tpl, merged);
    if (errs.length) errors.push(`场景「${scene.headline}」(模板 ${scene.template}): ${errs.join("; ")}`);
    else scene.data = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v as string | number]));
  }
  return errors;
}

/** LLM Call#1：表格 → 视频脚本（Zod 校验 + 模板变量校验失败自动回喂重试） */
export async function planScript(table: Table, opts: PlanOptions = {}): Promise<VideoScript> {
  let client = opts.client;
  if (!client) {
    // 优先用设置中心的 LLM 配置（GUI 打包环境无 shell 环境变量），缺省回退 env
    const { loadSettings } = await import("@data-news/settings");
    const s = await loadSettings();
    client = new ArkClient({
      apiKey: s.llm.apiKey,
      baseURL: s.llm.baseUrl,
      model: s.llm.model,
    });
  }
  const docs = await templateDocs();
  const system = SYSTEM_PROMPT.replace("{{TEMPLATE_DOCS}}", docs);

  const hint = [
    opts.titleHint ? `视频主题提示：${opts.titleHint}` : "",
    opts.voice ? `指定音色：${opts.voice}` : "",
    opts.theme ? `指定主题：${opts.theme}` : "",
    opts.templates?.length ? `只能使用这些模板：${opts.templates.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const user = `${hint ? hint + "\n\n" : ""}源数据（数字只能从这里取）：
${tableToLlmSummary(table)}`;

  // TS 注意：json<T> 的 T 由 ZodType<T> 推断为 parse 的**输入**类型（含默认值字段的可选形态），
  // 这里显式收窄为 parse 输出（VideoScript）
  const r1 = await client.json(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    VideoScriptSchema,
    { minTokens: 2048, temperature: 0.3 }
  );
  const data: VideoScript = VideoScriptSchema.parse(r1.data);

  // 后置校验：场景级字段回填 + 模板变量契约（带一次自动回喂重试）
  const attempt = await validateScenes(data);
  if (attempt.length) {
    // 回喂：把校验错误发回模型修正（只重试一次，仍未过则抛错）
    const r2 = await client.json(
      [
        { role: "system", content: system },
        { role: "user", content: user },
        { role: "assistant", content: JSON.stringify(data) },
        {
          role: "user",
          content: `脚本未通过校验：\n${attempt.join("\n")}\n请修正后只输出完整 JSON。注意：headline/subline/theme 也可作为 data 变量；缺失的必填变量必须从源数据计算补全。`,
        },
      ],
      VideoScriptSchema,
      { minTokens: 2048, temperature: 0.2 }
    );
    const fix: VideoScript = VideoScriptSchema.parse(r2.data);
    const retryErrors = await validateScenes(fix);
    if (retryErrors.length) {
      throw new Error(`脚本变量校验失败（重试后）: ${retryErrors.join(" | ")}`);
    }
    return fix;
  }
  return data;
}
