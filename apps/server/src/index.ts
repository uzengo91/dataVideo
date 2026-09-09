import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { readFile, stat, mkdtemp, rm as rmPath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CreateJobRequestSchema } from "@data-news/shared";
import type { VideoScript, OmniVoiceTimbre } from "@data-news/shared";
import { loadManifest, resolveTemplateRoot } from "@data-news/templates";
import { ingestCsv } from "@data-news/pipeline";
import { planScript } from "@data-news/pipeline";
import { JobStore } from "./jobs.js";
import { resolveProvider } from "@data-news/tts";
import { ArkClient } from "@data-news/llm";

const PORT = Number(process.env.PORT ?? 8787);

const app = Fastify({ logger: { level: "info" }, bodyLimit: 2 * 1024 * 1024 });
void app.register(cors, { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" });

// 打包发行模式（STANDALONE=1）：直接托管 web 构建产物，单端口服务
if (process.env.STANDALONE === "1") {
  const webRoot = path.join(path.dirname(process.execPath), "resources", "web");
  void app.register(fastifyStatic, { root: webRoot, prefix: "/" });
}

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
  const body = req.body as { text?: string; engine?: string; timbre?: string; voice?: string };
  const text = (body.text ?? "").trim().slice(0, 120);
  if (!text) return reply.code(400).send({ error: "缺少试听文本" });
  const engine = ["omnivoice", "macos-say", "edge-tts"].includes(body.engine ?? "") ? body.engine! : "auto";
  const timbre = body.timbre;
  const voice = body.voice ?? "zh-female-1";

  const cacheKey = `${engine}|${timbre ?? ""}|${voice}|${text}`;
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
      await provider.synthesize(text, voice as "zh-female-1", out);
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
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }
};
start();
