import { randomUUID } from "node:crypto";
import pQueue from "p-queue";
import type { CreateJobRequest, JobEvent, VideoScript } from "@data-news/shared";
import { runPipeline } from "@data-news/pipeline";

export interface JobRecord {
  id: string;
  request: CreateJobRequest;
  status: JobEvent["status"];
  progress: number;
  message: string;
  renderPercent?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  script?: VideoScript;
  videoFile?: string;
  projectZip?: string;
}

type Listener = (e: JobEvent) => void;

/** 进程内任务注册表 + 并发队列（MVP 单机；二期可换 BullMQ+Redis） */
export class JobStore {
  private jobs = new Map<string, JobRecord>();
  private listeners = new Map<string, Set<Listener>>();
  private queue: InstanceType<typeof pQueue>;

  constructor(concurrency = Number(process.env.RENDER_CONCURRENCY ?? 2)) {
    // p-queue 是默认导出的类
    const Q = pQueue as unknown as new (o: { concurrency: number }) => InstanceType<typeof pQueue>;
    this.queue = new Q({ concurrency });
  }

  create(req: CreateJobRequest): JobRecord {
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const rec: JobRecord = { id, request: req, status: "queued", progress: 0, message: "排队中", createdAt: now, updatedAt: now };
    this.jobs.set(id, rec);
    this.enqueue(id, req);
    return rec;
  }

  private enqueue(id: string, req: CreateJobRequest) {
    void this.queue
      .add(() => this.run(id, req))
      .catch(() => {/* 错误已在 run 内落账 */});
  }

  private async run(id: string, req: CreateJobRequest) {
    this.update(id, { status: "ingesting", progress: 5, message: "解析 CSV" });
    try {
      const result = await runPipeline(id, req, {
        onEvent: (e) => {
          // done 的产物信息统一在外层落账（此处避免引用未初始化的 result）
          this.update(id, { status: e.status, progress: e.progress, message: e.message });
        },
        onRenderProgress: (p) => this.update(id, { renderPercent: p }),
      });
      this.update(id, {
        status: "done",
        progress: 100,
        message: "完成",
        script: result.script,
        videoFile: result.videoFile,
        projectZip: `${result.videoFile.replace(/video\.mp4$/, "")}project.zip`,
      });
    } catch (err) {
      this.update(id, { status: "failed", message: "失败", error: String((err as Error).message ?? err) });
    }
  }

  private update(id: string, patch: Partial<JobRecord>) {
    const rec = this.jobs.get(id);
    if (!rec) return;
    Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
    const event: JobEvent = {
      jobId: id,
      status: rec.status,
      progress: rec.progress,
      message: rec.message,
      renderPercent: rec.renderPercent,
      error: rec.error,
      at: rec.updatedAt,
    };
    for (const l of this.listeners.get(id) ?? []) {
      try {
        l(event);
      } catch {
        /* 监听器异常不断链 */
      }
    }
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  subscribe(id: string, fn: Listener): () => void {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id)!.add(fn);
    return () => this.listeners.get(id)?.delete(fn);
  }
}
