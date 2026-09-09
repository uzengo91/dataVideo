import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { readFile, stat, mkdtemp, rm as rmPath, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreateJobRequestSchema } from "@data-news/shared";
import type { VideoScript, OmniVoiceTimbre } from "@data-news/shared";
import { loadManifest, resolveTemplateRoot } from "@data-news/templates";
import { ingestCsv } from "@data-news/pipeline";
import { planScript } from "@data-news/pipeline";
import { JobStore } from "./jobs.js";
import { resolveProvider, synthesizeByVoiceName, engineCatalog } from "@data-news/tts";
import { spawn } from "node:child_process";
import { loadSettings, saveSettings, setDataDir } from "@data-news/settings";
import { ArkClient } from "@data-news/llm";

const PORT = Number(process.env.PORT ?? 8787);

const app = Fastify({ logger: { level: "info" }, bodyLimit: 2 * 1024 * 1024 });
void app.register(cors, { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" });

// 打包发行模式（STANDALONE=1）：直接托管 web 构建产物，单端口服务
if (process.env.STANDALONE === "1") {
  const candidates = [
    path.join(path.dirname(process.execPath), "resources", "web"), // pkg 便携布局
    path.resolve(process.cwd(), "../web/dist"),                     // 仓库内直跑
  ];
  let webRoot = candidates[0];
  for (const c of candidates) {
    if (existsSync(path.join(c, "index.html"))) { webRoot = c; break; }
  }
  void app.register(fastifyStatic, { root: webRoot, prefix: "/" });
}


if (process.env.JOB_DATA_DIR) setDataDir(process.env.JOB_DATA_DIR);
const store = new JobStore();

// 健康检查
app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

// 模板清单（前端展示用）
app.get("/api/templates", async () => {
  const m = await loadManifest();
  return m.templates.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    sceneHint: t.sceneHint,
    duration: t.duration,
  }));
});

// 创建任务（含 scriptOverride 时跳过 AI 脚本，直接渲染用户确认的版本）
app.post("/api/jobs", async (req, reply) => {
  const parsed = CreateJobRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "请求不合法", details: parsed.error.issues });
  }
  const rec = store.create(parsed.data);
  return reply.code(202).send({ jobId: rec.id, status: rec.status });
});

// ---------- 设置中心 ----------
app.get("/api/settings", async () => {
  const s = await loadSettings();
  return {
    llm: s.llm,
    tts: Object.fromEntries(Object.entries(s.tts).map(([k, v]) => [k, { ...v, apiKey: v.apiKey ? "•••已配置" : "" }])),
  };
});

app.post("/api/settings", async (req, reply) => {
  const body = req.body as { llm?: Record<string, unknown>; tts?: Record<string, Record<string, unknown>> };
  // apiKey 传 "•••已配置" 表示未修改，跳过覆盖
  const clean: typeof body = { llm: body.llm, tts: {} };
  if (body.tts) {
    for (const [engine, cfg] of Object.entries(body.tts)) {
      const c = { ...cfg };
      if (c.apiKey === "•••已配置") delete c.apiKey;
      (clean.tts as Record<string, Record<string, unknown>>)[engine] = c;
    }
  }
  if (clean.llm && (clean.llm as { apiKey?: string }).apiKey === "•••已配置") {
    delete (clean.llm as { apiKey?: string }).apiKey;
  }
  await saveSettings(clean as never);
  return { ok: true };
});

// TTS 引擎目录（设置页/确认页音色列表）
app.get("/api/tts/engines", async () => engineCatalog());

// LLM 连通性测试
app.post("/api/llm/test", async (req, reply) => {
  const body = req.body as { provider?: string; apiKey?: string; baseUrl?: string; model?: string; save?: boolean };
  if (body.save) {
    await saveSettings({ llm: { provider: (body.provider as "openai" | "claude") ?? "openai", apiKey: body.apiKey, baseUrl: body.baseUrl, model: body.model } });
  }
  try {
    const { ArkClient } = await import("@data-news/llm");
    const { loadSettings: ls } = await import("@data-news/settings");
    const s = await ls();
    const provider = body.provider ?? s.llm.provider ?? "openai";
    const apiKey = body.apiKey && body.apiKey !== "•••已配置" ? body.apiKey : s.llm.apiKey;
    const baseUrl = body.baseUrl ?? s.llm.baseUrl;
    const model = body.model ?? s.llm.model;
    const client = provider === "claude"
      ? new ArkClient({ apiKey, model: model || "claude-sonnet-4-5", baseURL: baseUrl || "https://api.anthropic.com/v1" })
      : new ArkClient({ apiKey, model: model || "glm-5.3-flash", baseURL: baseUrl });
    const r = await client.chat([{ role: "user", content: "请原样输出: ok" }], { minTokens: 16 });
    return { ok: r.content.toLowerCase().includes("ok"), model: client.model, sample: r.content.slice(0, 60), elapsedMs: r.elapsedMs };
  } catch (e) {
    return reply.code(502).send({ ok: false, error: (e as Error).message.slice(0, 300) });
  }
});

// CSV 格式校验（首页"下一步"前置调用）
app.post("/api/csv/validate", async (req, reply) => {
  const body = req.body as { csv?: string };
  try {
    const table = ingestCsv(body.csv ?? "");
    const numericCols = table.columns.filter((c) => c.type === "number").map((c) => c.name);
    return {
      ok: true,
      rowCount: table.rowCount,
      columns: table.columns,
      numericCols,
      warnings: [
        ...(table.rowCount < 2 ? ["数据少于 2 行，建议至少 2 行"] : []),
        ...(numericCols.length === 0 ? ["未识别到数字列，图表类模板将无法展示数值"] : []),
      ],
    };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: (e as Error).message });
  }
});

// 试听（voiceName 分发版）
// 模板/主题样例视频（确认页预览用）：samples/<template>__<theme>.mp4
app.get<{ Params: { tpl: string; theme: string } }>(
  "/api/samples/:tpl/:theme",
  async (req, reply) => {
    if (!/^[\w-]+$/.test(req.params.tpl) || !/^[\w-]+$/.test(req.params.theme)) {
      return reply.code(400).send({ error: "非法参数" });
    }
    const root = await resolveTemplateRoot();
    const file = path.join(root, "samples", `${req.params.tpl}__${req.params.theme}.mp4`);
    try {
      await stat(file);
    } catch {
      return reply.code(404).send({ error: "样例不存在" });
    }
    reply.type("video/mp4");
    return reply.send(await readFile(file));
  }
);

// 解说词试听：用与渲染完全一致的 TTS 链路合成短句，返回 mp3（可缓存）
const previewCache = new Map<string, Buffer>();
app.post("/api/tts/preview", async (req, reply) => {
  const body = req.body as { text?: string; engine?: string; timbre?: string; voice?: string; voiceName?: string };
  const text = (body.text ?? "").trim().slice(0, 120);
  if (!text) return reply.code(400).send({ error: "缺少试听文本" });
  const timbre = body.timbre;
  const voice = body.voice ?? "zh-female-1";
  const engine = body.voiceName
    ? body.voiceName.slice(0, body.voiceName.indexOf(":") === -1 ? undefined : body.voiceName.indexOf(":"))
    : (["omnivoice", "macos-say", "edge-tts"].includes(body.engine ?? "") ? body.engine! : "auto");

  const cacheKey = `${engine}|${timbre ?? ""}|${body.voiceName ?? voice}|${text}`;
  const cached = previewCache.get(cacheKey);
  if (cached) {
    reply.type("audio/mpeg");
    return reply.send(cached);
  }
  try {
    const provider = await resolveProvider(engine as "auto", timbre);
    const tmp = await mkdtemp(path.join(os.tmpdir(), "tts-prev-"));
    try {
      const out = path.join(tmp, "prev.mp3");
      if (body.voiceName) {
        await synthesizeByVoiceName(text, body.voiceName, out, { timbre });
      } else {
        await provider.synthesize(text, voice as "zh-female-1", out);
      }
      const buf = await readFile(out);
      previewCache.set(cacheKey, buf);
      reply.type("audio/mpeg");
      return reply.send(buf);
    } finally {
      await rmPath(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    return reply.code(502).send({ error: `试听失败: ${(e as Error).message}` });
  }
});

// 脚本草稿预览：LLM 生成一次供用户编辑/换模板，不创建任务、不渲染
app.post("/api/script/preview", async (req, reply) => {
  const body = req.body as { csv?: string; titleHint?: string; theme?: string };
  if (!body.csv || body.csv.length < 10) {
    return reply.code(400).send({ error: "CSV 内容太短" });
  }
  try {
    const table = ingestCsv(body.csv);
    const script = await planScript(table, {
      titleHint: body.titleHint,
      theme: body.theme as VideoScript["theme"] | undefined,
      client: new ArkClient(),
    });
    return script;
  } catch (e) {
    return reply.code(502).send({ error: `脚本生成失败: ${(e as Error).message}` });
  }
});

// 查询任务
app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
  const rec = store.get(req.params.id);
  if (!rec) return reply.code(404).send({ error: "任务不存在" });
  return {
    jobId: rec.id,
    status: rec.status,
    progress: rec.progress,
    message: rec.message,
    renderPercent: rec.renderPercent,
    error: rec.error,
    script: rec.script,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    downloads: rec.videoFile
      ? { video: `/api/jobs/${rec.id}/download/video`, project: `/api/jobs/${rec.id}/download/project` }
      : undefined,
  };
});

// SSE 进度流
app.get<{ Params: { id: string } }>("/api/jobs/:id/events", async (req, reply) => {
  const rec = store.get(req.params.id);
  if (!rec) return reply.code(404).send({ error: "任务不存在" });

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": process.env.WEB_ORIGIN ?? "http://localhost:3000",
  });
  const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);

  // 先推当前状态
  send({
    jobId: rec.id,
    status: rec.status,
    progress: rec.progress,
    message: rec.message,
    renderPercent: rec.renderPercent,
    error: rec.error,
    at: new Date().toISOString(),
  });

  const unsub = store.subscribe(rec.id, (e) => {
    send(e);
    if (e.status === "done" || e.status === "failed") {
      unsub();
      reply.raw.end();
    }
  });
  req.raw.on("close", () => {
    unsub();
  });
});

// 下载成片 / 工程包
app.get<{ Params: { id: string; kind: string } }>("/api/jobs/:id/download/:kind", async (req, reply) => {
  const rec = store.get(req.params.id);
  if (!rec) return reply.code(404).send({ error: "任务不存在" });
  const file = req.params.kind === "video" ? rec.videoFile : req.params.kind === "project" ? rec.projectZip : undefined;
  if (!file) return reply.code(409).send({ error: "产物尚未生成" });
  try {
    await stat(file);
  } catch {
    return reply.code(410).send({ error: "产物文件已不存在" });
  }
  const name = path.basename(file);
  reply.header("content-disposition", `attachment; filename="${name}"`);
  if (name.endsWith(".zip")) reply.type("application/zip");
  else reply.type("video/mp4");
  return reply.send(await readFile(file));
});

const start = async () => {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info(`data-news server listening on :${PORT}`);
    // 本地软件体验：启动后自动打开浏览器（standalone 模式）
    if (process.env.STANDALONE === "1" && !process.env.NO_OPEN) {
      const mod = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      const child = spawn(mod, process.platform === "win32" ? ["", `http://localhost:${PORT}`] : [`http://localhost:${PORT}`], {
        shell: process.platform === "win32", detached: true, stdio: "ignore",
      });
      child.unref();
    }
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }
};
start();
