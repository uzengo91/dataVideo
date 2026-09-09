import { z } from "zod";

/** 主题（模板多主题体系） */
export const ThemeSchema = z.enum([
  "dark-finance",
  "light-tech",
  "violet-trend",
  "warm-sunrise",
  "cool-mint",
  "ink-classic",
]);
export type Theme = z.infer<typeof ThemeSchema>;

/** 主题展示元数据（前端主题卡片用） */
export const THEME_META: Record<Theme, { label: string; hint: string }> = {
  "dark-finance": { label: "深色金融", hint: "财报 / 证券 / 专业分析" },
  "light-tech": { label: "浅色科技", hint: "科技 / 增长 / SaaS" },
  "violet-trend": { label: "紫韵潮流", hint: "潮流 / 年轻人群 / 文娱" },
  "warm-sunrise": { label: "暖阳生活", hint: "生活方式 / 消费 / 零售" },
  "cool-mint": { label: "清新薄荷", hint: "健康 / 环保 / 教育" },
  "ink-classic": { label: "水墨鎏金", hint: "高端 / 奢品 / 文化" },
};

/** 音色（TTS provider 抽象后的逻辑音色） */
export const VoiceSchema = z.enum(["zh-female-1", "zh-male-1", "en-female-1", "en-male-1"]);
export type Voice = z.infer<typeof VoiceSchema>;

/** TTS 引擎（omnivoice = 本地 OmniVoice 神经网络语音，免费离线） */
export const TtsEngineSchema = z.enum(["auto", "omnivoice", "macos-say", "edge-tts"]);
export type TtsEngine = z.infer<typeof TtsEngineSchema>;

/** OmniVoice 声音设计词表（instruct，全角逗号分隔；中文词表，不可中英混用） */
export const OmniVoiceTimbreSchema = z.enum([
  "女，青年，中音调",
  "女，青年，高音调",
  "女，中年，中音调",
  "男，青年，中音调",
  "男，青年，低音调",
  "男，中年，中音调",
]);
export type OmniVoiceTimbre = z.infer<typeof OmniVoiceTimbreSchema>;

/** 音色配置：逻辑音色（say/edge 引擎用）或 OmniVoice 音色描述 */
export const VoiceConfigSchema = z.object({
  voice: VoiceSchema.default("zh-female-1"),
  engine: TtsEngineSchema.default("auto"),
  /** 仅 engine=omnivoice 时生效 */
  timbre: OmniVoiceTimbreSchema.optional(),
});
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

/** 单个场景：LLM 产出的最小数据单元。data 必须只引用源数据字段。 */
export const SceneSchema = z.object({
  /** 模板库 ID，对应 templates/manifest.json 里的 id */
  template: z.string().min(1),
  /** 解说词（送 TTS），不含无法发音的符号 */
  narration: z.string().min(1).max(200),
  /** 屏幕上显示的标题 */
  headline: z.string().min(1).max(60),
  /** 副标题/来源说明 */
  subline: z.string().max(120).default(""),
  /** 图表/卡片数据（变量注入模板），值必须是字符串（已格式化） */
  data: z.record(z.string(), z.union([z.string(), z.number()])),
  /** 数字溯源：data 中每个关键值对应的源数据列名 */
  sourceRefs: z.array(z.string()).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

/** LLM Call#1 的完整输出：视频脚本 */
export const VideoScriptSchema = z.object({
  title: z.string().min(1).max(80),
  voice: VoiceSchema.default("zh-female-1"),
  theme: ThemeSchema.default("dark-finance"),
  scenes: z.array(SceneSchema).min(1).max(8),
});
export type VideoScript = z.infer<typeof VideoScriptSchema>;

/** 解析后的表格数据（ingest 产物） */
export const TableSchema = z.object({
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["number", "string", "date"]),
      sample: z.string(),
    })
  ),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).max(500),
  rowCount: z.number().int().nonnegative(),
});
export type Table = z.infer<typeof TableSchema>;

/** 任务状态机 */
export const JobStatusSchema = z.enum([
  "queued",
  "ingesting",
  "scripting",
  "tts",
  "composing",
  "rendering",
  "verifying",
  "done",
  "failed",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** 渲染质量 */
export const QualitySchema = z.enum(["draft", "standard", "high"]);
export type Quality = z.infer<typeof QualitySchema>;

/** 用户对 LLM 脚本的逐场景覆盖（确认页编辑后的形态） */
export const SceneOverrideSchema = z.object({
  /** 模板 ID（可换模板） */
  template: z.string().min(1),
  headline: z.string().min(1).max(60),
  subline: z.string().max(120).default(""),
  /** 解说词（用户可改；改后重新 TTS） */
  narration: z.string().min(1).max(300),
  data: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type SceneOverride = z.infer<typeof SceneOverrideSchema>;

/** 创建任务请求 */
export const CreateJobRequestSchema = z.object({
  csv: z.string().min(10, "CSV 内容太短").max(200_000),
  titleHint: z.string().max(80).optional(),
  voice: VoiceSchema.optional(),
  theme: ThemeSchema.optional(),
  /** 限定可用的模板 ID；缺省则全部可用 */
  templates: z.array(z.string()).optional(),
  quality: QualitySchema.optional(),
  /** 完整音色配置（优先于 voice 字段） */
  voiceConfig: VoiceConfigSchema.optional(),
  /**
   * 用户确认后的脚本覆盖。提供时跳过 LLM Call#1（不再生成脚本），
   * 直接按覆盖内容走 TTS → 渲染。标题/主题也以覆盖为准。
   */
  scriptOverride: z
    .object({
      title: z.string().min(1).max(80),
      theme: ThemeSchema,
      voice: VoiceConfigSchema.optional(),
      scenes: z.array(SceneOverrideSchema).min(1).max(8),
    })
    .optional(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

/** SSE 事件 */
export const JobEventSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  /** 0-100 */
  progress: z.number().min(0).max(100),
  message: z.string().default(""),
  /** 渲染阶段 0-100 */
  renderPercent: z.number().min(0).max(100).optional(),
  /** 完成时的产物 */
  artifacts: z
    .object({
      video: z.string().optional(),
      projectZip: z.string().optional(),
      script: VideoScriptSchema.optional(),
    })
    .optional(),
  error: z.string().optional(),
  at: z.string(),
});
export type JobEvent = z.infer<typeof JobEventSchema>;

/** 全部模板 ID 常量（与 packages/templates/manifest.json 对齐） */
export const TEMPLATE_IDS = [
  "kpi-headline",
  "number-counter",
  "line-trend",
  "bar-race",
  "donut-share",
  "waterfall",
  "geo-map",
  "data-table-reveal",
  "compare-split",
  "quote-insight",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
