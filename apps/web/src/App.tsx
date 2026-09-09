import React, { useCallback, useEffect, useRef, useState } from "react";

type JobStatus =
  | "queued" | "ingesting" | "scripting" | "tts" | "composing"
  | "rendering" | "verifying" | "done" | "failed";

interface Scene {
  template: string;
  headline: string;
  subline: string;
  narration: string;
  data: Record<string, string | number>;
}
interface Script {
  title: string;
  theme: string;
  voice: string;
  scenes: Scene[];
}
interface JobState {
  jobId: string;
  status: JobStatus;
  progress: number;
  message: string;
  renderPercent?: number;
  error?: string;
  script?: Script;
  downloads?: { video: string; project: string };
}

const SAMPLE_CSV = `月份,营收(万元),同比增长,毛利率
1月,1180,12%,41.2
2月,1245,15%,42.0
3月,1390,18%,42.8
4月,1452,16%,43.1
5月,1560,21%,43.6
6月,1712,23%,44.2`;

// 模板清单从后端 manifest 动态拉取（新增模板/官方块自动出现）；以下仅作为拉取前的兜底排序
const TEMPLATE_ORDER = [
  "kpi-headline", "number-counter", "line-trend", "bar-race", "donut-share",
  "waterfall", "geo-map", "data-table-reveal", "compare-split", "quote-insight",
];

const THEMES = [
  { id: "dark-finance", label: "深色金融", hint: "财报 / 证券 / 专业分析" },
  { id: "light-tech", label: "浅色科技", hint: "科技 / 增长 / SaaS" },
  { id: "violet-trend", label: "紫韵潮流", hint: "潮流 / 年轻人群 / 文娱" },
  { id: "warm-sunrise", label: "暖阳生活", hint: "生活方式 / 消费 / 零售" },
  { id: "cool-mint", label: "清新薄荷", hint: "健康 / 环保 / 教育" },
  { id: "ink-classic", label: "水墨鎏金", hint: "高端 / 奢品 / 文化" },
];

const VOICES = [
  { engine: "omnivoice", timbre: "女，青年，中音调", label: "知性女声（本地 AI）" },
  { engine: "omnivoice", timbre: "男，青年，中音调", label: "沉稳男声（本地 AI）" },
  { engine: "omnivoice", timbre: "女，中年，中音调", label: "权威女声（本地 AI）" },
  { engine: "omnivoice", timbre: "男，青年，低音调", label: "低音男声（本地 AI）" },
  { engine: "macos-say", voice: "zh-female-1", label: "系统女声 婷婷" },
  { engine: "macos-say", voice: "zh-male-1", label: "系统男声" },
];

const STATUS_TEXT: Record<JobStatus, string> = {
  queued: "排队中",
  ingesting: "解析 CSV",
  scripting: "AI 生成脚本",
  tts: "合成语音",
  composing: "装配工程",
  rendering: "渲染视频",
  verifying: "校验产物",
  done: "完成",
  failed: "失败",
};

export default function App() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [csv, setCsv] = useState(SAMPLE_CSV);
  const [titleHint, setTitleHint] = useState("");
  const [quality, setQuality] = useState("draft");

  // 确认页状态
  const [script, setScript] = useState<Script | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [voiceIdx, setVoiceIdx] = useState(0);

  const [job, setJob] = useState<JobState | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const [previewingVoice, setPreviewingVoice] = useState<"loading" | "playing" | `scene-${number}` | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [templates, setTemplates] = useState<{ id: string; name: string; hint: string; sceneHint: string }[]>([]);

  useEffect(() => {
    fetch("/api/templates")
      .then((r) => r.json())
      .then((list: { id: string; name: string; description: string; sceneHint: string }[]) => {
        const mapped = list.map((t) => ({
          id: t.id,
          name: t.name,
          hint: t.sceneHint || t.description,
          sceneHint: t.sceneHint,
        }));
        // 自研 10 套按固定顺序排前，官方块按 manifest 顺序跟后
        mapped.sort((a, b) => {
          const ia = TEMPLATE_ORDER.indexOf(a.id);
          const ib = TEMPLATE_ORDER.indexOf(b.id);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
        setTemplates(mapped);
      })
      .catch(() => {});
  }, []);

  const playPreview = useCallback(async (text: string, voiceSel: typeof VOICES[number], key: "loading" | `scene-${number}`) => {
    setPreviewingVoice(key);
    try {
      audioRef.current?.pause();
      const r = await fetch("/api/tts/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, engine: voiceSel.engine, timbre: voiceSel.timbre, voice: voiceSel.voice }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "试听失败");
      const blob = await r.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      audio.onended = () => setPreviewingVoice(null);
      await audio.play();
      setPreviewingVoice("playing");
    } catch (e) {
      alert((e as Error).message);
      setPreviewingVoice(null);
    }
  }, []);

  const previewVoice = useCallback(() => {
    void playPreview("大家好，这是配音音色试听效果，数据不会说谎。", VOICES[voiceIdx], "loading");
  }, [playPreview, voiceIdx]);

  const previewSceneVoice = useCallback((i: number) => {
    const s = script?.scenes[i];
    if (s?.narration) void playPreview(s.narration, VOICES[voiceIdx], `scene-${i}`);
  }, [script, voiceIdx, playPreview]);

  const rows = csv.trim() ? csv.trim().split("\n").length - 1 : 0;

  // Step2 → Step3：请求 LLM 草稿
  const generateDraft = useCallback(async () => {
    setPreviewing(true);
    setPreviewError("");
    try {
      const r = await fetch("/api/script/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv, titleHint: titleHint || undefined, theme: "dark-finance" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setScript(d);
      setStep(3);
    } catch (e) {
      setPreviewError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }, [csv, titleHint]);

  const patchScene = (i: number, patch: Partial<Scene>) => {
    setScript((s) => {
      if (!s) return s;
      const scenes = s.scenes.map((sc, j) => (j === i ? { ...sc, ...patch } : sc));
      return { ...s, scenes };
    });
  };

  // Step3 → Step4：用户确认后才创建任务
  const startJob = useCallback(async () => {
    if (!script) return;
    const voice = VOICES[voiceIdx];
    const r = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        csv, // 渲染仍需源数据（溯源/校验）
        quality,
        voiceConfig: { engine: voice.engine, voice: voice.voice ?? "zh-female-1", timbre: voice.timbre },
        scriptOverride: {
          title: script.title,
          theme: script.theme,
          scenes: script.scenes.map((s) => ({
            template: s.template,
            headline: s.headline,
            subline: s.subline,
            narration: s.narration,
            data: s.data,
          })),
        },
      }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(`创建失败: ${d.error ?? r.status}`);
      return;
    }
    const { jobId } = await r.json();
    setJob({ jobId, status: "queued", progress: 0, message: "排队中" });
    setStep(4);
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as JobState;
      setJob(e);
      if (e.status === "done" || e.status === "failed") {
        es.close();
        fetch(`/api/jobs/${jobId}`).then((x) => x.json()).then(setJob).catch(() => {});
      }
    };
    es.onerror = () => {
      es.close();
      fetch(`/api/jobs/${jobId}`).then((x) => x.json()).then(setJob).catch(() => {});
    };
  }, [script, csv, quality, voiceIdx]);

  useEffect(() => () => esRef.current?.close(), []);

  const rendering = job && !["done", "failed"].includes(job.status);
  const renderPct = job?.renderPercent ?? 0;

  return (
    <div className="container">
      <h1>AI 数据解说短视频工厂</h1>
      <p className="subtitle">粘贴 CSV → AI 起草脚本 → 你确认文案与模板 → 无幻觉 1080p60 数据视频</p>

      <div className="steps">
        {([1, 2, 3, 4] as const).map((s) => (
          <div key={s} className={`step-chip ${step === s ? "active" : step > s ? "done" : ""}`}>
            {s === 1 ? "① 粘贴数据" : s === 2 ? "② 生成设定" : s === 3 ? "③ 确认脚本" : "④ 渲染出片"}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="card">
          <h2>粘贴你的 CSV 数据</h2>
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} />
          <p className="hint">识别到 {rows} 行数据。首行为表头；至少一列数字。</p>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="primary" disabled={rows < 2} onClick={() => setStep(2)}>
              下一步：生成设定
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <>
          <div className="card">
            <h2>视频设定</h2>
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="subtitle" style={{ margin: 0 }}>渲染档位</span>
              <label className="radio">
                <input type="radio" checked={quality === "draft"} onChange={() => setQuality("draft")} />
                快速预览（draft）
              </label>
              <label className="radio">
                <input type="radio" checked={quality === "standard"} onChange={() => setQuality("standard")} />
                正式成片（standard）
              </label>
            </div>
            <div className="row">
              <span className="subtitle" style={{ margin: 0 }}>主题提示（可选）</span>
              <input
                className="text-input"
                value={titleHint}
                onChange={(e) => setTitleHint(e.target.value)}
                placeholder="如：半年经营回顾"
              />
            </div>
          </div>
          <div className="row">
            <button className="ghost" onClick={() => setStep(1)}>返回修改数据</button>
            <button className="primary" disabled={previewing} onClick={generateDraft}>
              {previewing ? "AI 起草中…（约 1 分钟）" : "生成脚本草稿"}
            </button>
          </div>
          {previewError && <div className="error-box">{previewError}</div>}
        </>
      )}

      {step === 3 && script && (
        <>
          <div className="card">
            <h2>
              确认脚本与配音
              <span style={{ float: "right", color: "var(--muted)", fontSize: 13 }}>所有文案均可编辑</span>
            </h2>

            <div className="edit-block">
              <label className="edit-label">视频标题（显示在分享/文件名，不出现在画面）</label>
              <input
                className="text-input"
                value={script.title}
                onChange={(e) => setScript({ ...script, title: e.target.value })}
              />
            </div>

            <div className="edit-block">
              <label className="edit-label">主题风格（点击卡片切换，右侧预览该主题的真实渲染样例）</label>
              <div className="theme-grid">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    className={`theme-card ${script.theme === t.id ? "selected" : ""}`}
                    onClick={() => setScript({ ...script, theme: t.id })}
                    title={t.hint}
                  >
                    <video
                      src={`/api/samples/${script.scenes[0]?.template ?? "kpi-headline"}/${t.id}`}
                      autoPlay muted loop playsInline
                      onError={(e) => ((e.target as HTMLVideoElement).style.display = "none")}
                    />
                    <span className="theme-name">{t.label}</span>
                    <span className="theme-hint">{t.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="edit-block">
              <label className="edit-label">配音音色（试听后再定；本地 AI 音色更自然）</label>
              <div className="row">
                <select
                  className="text-input voice-select"
                  value={voiceIdx}
                  onChange={(e) => setVoiceIdx(Number(e.target.value))}
                >
                  {VOICES.map((v, i) => (
                    <option key={i} value={i}>{v.label}</option>
                  ))}
                </select>
                <button className="ghost" disabled={previewingVoice === "loading"} onClick={previewVoice}>
                  {previewingVoice === "loading" ? "合成中…" : previewingVoice === "playing" ? "播放中…" : "▶ 试听"}
                </button>
              </div>
            </div>

            <div className="edit-block">
              <label className="edit-label">
                分镜脚本（{script.scenes.length} 个场景）
                <span className="edit-subhint">每行从上到下依次播放：下拉框换该镜头的画面模板 → 屏幕标题/副标题改画面文字 → 解说词决定这一段的配音，改动后都会重新配音合成</span>
              </label>
              {script.scenes.map((s, i) => (
                <div className="scene-editor" key={i}>
                  <div className="scene-head">
                    <span className="scene-num">#{i + 1}</span>
                    <select
                      className="tpl-select"
                      value={s.template}
                      title={`换模板：${templates.find((t) => t.id === s.template)?.hint ?? ""}`}
                      onChange={(e) => patchScene(i, { template: e.target.value })}
                    >
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>{t.name} · {t.hint}</option>
                      ))}
                    </select>
                    <div className="tpl-preview">
                      <video
                        src={`/api/samples/${s.template}/${script.theme}`}
                        autoPlay muted loop playsInline
                        onError={(e) => ((e.target as HTMLVideoElement).style.display = "none")}
                      />
                    </div>
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label className="edit-label">屏幕标题（画面大字，≤30 字）</label>
                      <input
                        className="text-input"
                        value={s.headline}
                        onChange={(e) => patchScene(i, { headline: e.target.value })}
                        placeholder="如：Q3 营收"
                      />
                    </div>
                    <div className="field">
                      <label className="edit-label">副标题（画面小字，可留空）</label>
                      <input
                        className="text-input"
                        value={s.subline}
                        onChange={(e) => patchScene(i, { subline: e.target.value })}
                        placeholder="如：单位：人民币"
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label className="edit-label">
                      解说词（配音逐字朗读，15~80 字效果最佳）
                      <button
                        className="link-btn"
                        onClick={() => previewSceneVoice(i)}
                        disabled={previewingVoice === `scene-${i}`}
                      >
                        {previewingVoice === `scene-${i}` ? "合成中…" : "▶ 试听本段"}
                      </button>
                    </label>
                    <textarea
                      className="narration-input"
                      value={s.narration}
                      onChange={(e) => patchScene(i, { narration: e.target.value })}
                      placeholder="解说词（将逐字配音）"
                      rows={2}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="row">
            <button className="ghost" onClick={() => setStep(2)}>返回重新起草</button>
            <button className="primary" onClick={startJob}>确认无误，开始渲染</button>
          </div>
        </>
      )}

      {step === 4 && job && (
        <div className="card">
          <h2>
            {rendering ? "正在生成…" : job.status === "done" ? "生成完成" : "生成失败"}
            <span style={{ float: "right", color: "var(--muted)", fontSize: 14 }}>任务 {job.jobId}</span>
          </h2>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{
                width: `${job.status === "done" ? 100 : job.status === "failed" ? 100 : Math.max(job.progress, renderPct > 0 ? 50 + renderPct * 0.4 : job.progress)}%`,
                background: job.status === "failed" ? "var(--accent2)" : "var(--accent)",
              }}
            />
          </div>
          <div className="status-line">
            <span>{STATUS_TEXT[job.status]} {job.message ? `· ${job.message}` : ""}</span>
            <span>{rendering && renderPct > 0 ? `渲染 ${renderPct}%` : `${job.progress}%`}</span>
          </div>

          {job.status === "failed" && <div className="error-box">{job.error}</div>}

          {job.status === "done" && job.downloads && (
            <>
              <video className="result" src={`/api/jobs/${job.jobId}/download/video`} controls />
              <div className="dl-row">
                <a href={`/api/jobs/${job.jobId}/download/video`} download>
                  <button className="primary">下载视频 MP4</button>
                </a>
                <a href={`/api/jobs/${job.jobId}/download/project`} download>
                  <button className="ghost">下载工程包（可手工微调重渲）</button>
                </a>
                <button className="ghost" onClick={() => { setJob(null); setStep(3); }}>
                  返回改脚本再来一条
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
