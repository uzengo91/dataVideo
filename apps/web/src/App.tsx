import React, { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n.js";

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
interface EngineInfo {
  id: string;
  label: string;
  needsKey: boolean;
  selfHosted: boolean;
  free: boolean;
  voices: string[];
  fields: { key: string; label: string; placeholder?: string }[];
}
interface CsvValidation {
  ok: boolean;
  rowCount?: number;
  columns?: { name: string; type: string; sample: string }[];
  numericCols?: string[];
  warnings?: string[];
  error?: string;
}

const SAMPLE_CSV = `月份,营收(万元),同比增长,毛利率
1月,1180,12%,41.2
2月,1245,15%,42.0
3月,1390,18%,42.8
4月,1452,16%,43.1
5月,1560,21%,43.6
6月,1712,23%,44.2`;

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

/** 预置音色（voiceName 全名，与 MoneyPrinterTurbo 引擎命名一致） */
const PRESET_VOICES = [
  { voiceName: "azure-v1:zh-CN-XiaoxiaoNeural", label: "晓晓（Edge 免费）" },
  { voiceName: "azure-v1:zh-CN-YunxiNeural", label: "云希（Edge 免费）" },
  { voiceName: "say:zh-female-1", label: "macOS 婷婷" },
  { voiceName: "omnivoice", label: "OmniVoice 知性女声（本地 AI）" },
  { voiceName: "omnivoice", label: "OmniVoice 沉稳男声（本地 AI）", timbre: "男，青年，中音调" },
];
function enginePresetVoices(engines: EngineInfo[]): { voiceName: string; label: string }[] {
  const out: { voiceName: string; label: string }[] = [];
  for (const e of engines) {
    if (["azure-v1", "say", "omnivoice", "no-voice"].includes(e.id)) continue;
    if (e.id === "siliconflow") for (const v of e.voices.slice(0, 3)) out.push({ voiceName: `siliconflow:${v}`, label: `SiliconFlow ${v.split(":").pop()}` });
    else if (e.id === "gemini") for (const v of e.voices.slice(0, 3)) out.push({ voiceName: `gemini:${v}`, label: `Gemini ${v}` });
    else if (e.id === "minimax") for (const v of e.voices.slice(0, 3)) out.push({ voiceName: `minimax:${v}`, label: `MiniMax ${v}` });
    else if (e.id === "kokoro") for (const v of e.voices.slice(0, 3)) out.push({ voiceName: `kokoro:${v}`, label: `Kokoro ${v}` });
    else if (e.id === "chatterbox") out.push({ voiceName: "chatterbox:default", label: "Chatterbox 默认" });
  }
  return out;
}

export default function App() {
  const { t, lang, setLang } = useI18n();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [csv, setCsv] = useState(SAMPLE_CSV);
  const [csvMode, setCsvMode] = useState<"paste" | "upload">("paste");
  const [validation, setValidation] = useState<CsvValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [titleHint, setTitleHint] = useState("");
  const [quality, setQuality] = useState("draft");

  const [script, setScript] = useState<Script | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [voiceName, setVoiceName] = useState("azure-v1:zh-CN-XiaoxiaoNeural");

  const [job, setJob] = useState<JobState | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const [templates, setTemplates] = useState<{ id: string; name: string; hint: string }[]>([]);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"tts" | "llm">("tts");

  useEffect(() => {
    fetch("/api/templates").then((r) => r.json()).then((list: { id: string; name: string; description: string; sceneHint: string }[]) => {
      const mapped = list.map((t) => ({ id: t.id, name: t.name, hint: t.sceneHint || t.description }));
      mapped.sort((a, b) => {
        const ia = TEMPLATE_ORDER.indexOf(a.id); const ib = TEMPLATE_ORDER.indexOf(b.id);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
      setTemplates(mapped);
    }).catch(() => {});
    fetch("/api/tts/engines").then((r) => r.json()).then(setEngines).catch(() => {});
  }, []);

  const validateCsv = useCallback(async () => {
    setValidating(true);
    try {
      const r = await fetch("/api/csv/validate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const d = (await r.json()) as CsvValidation;
      setValidation(d);
      return d.ok === true;
    } finally { setValidating(false); }
  }, [csv]);

  const goStep2 = useCallback(async () => {
    if (await validateCsv()) setStep(2);
  }, [validateCsv]);

  const onFileChosen = useCallback(async (file: File) => {
    setCsv(await file.text());
    setCsvMode("upload");
    setValidation(null);
  }, []);

  const generateDraft = useCallback(async () => {
    setPreviewing(true); setPreviewError("");
    try {
      const r = await fetch("/api/script/preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv, titleHint: titleHint || undefined, theme: "dark-finance" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setScript(d); setStep(3);
    } catch (e) { setPreviewError((e as Error).message); } finally { setPreviewing(false); }
  }, [csv, titleHint]);

  const patchScene = (i: number, patch: Partial<Scene>) => {
    setScript((s) => s ? { ...s, scenes: s.scenes.map((sc, j) => (j === i ? { ...sc, ...patch } : sc)) } : s);
  };

  const startJob = useCallback(async () => {
    if (!script) return;
    const r = await fetch("/api/jobs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        csv, quality, voiceName,
        scriptOverride: {
          title: script.title, theme: script.theme,
          scenes: script.scenes.map((s) => ({ template: s.template, headline: s.headline, subline: s.subline, narration: s.narration, data: s.data })),
        },
      }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); alert(`创建失败: ${d.error ?? r.status}`); return; }
    const { jobId } = await r.json();
    setJob({ jobId, status: "queued", progress: 0, message: "排队中" }); setStep(4);
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as JobState; setJob(e);
      if (e.status === "done" || e.status === "failed") { es.close(); fetch(`/api/jobs/${jobId}`).then((x) => x.json()).then(setJob).catch(() => {}); }
    };
    es.onerror = () => { es.close(); fetch(`/api/jobs/${jobId}`).then((x) => x.json()).then(setJob).catch(() => {}); };
  }, [script, csv, quality, voiceName]);

  useEffect(() => () => esRef.current?.close(), []);

  const [previewingVoice, setPreviewingVoice] = useState<"loading" | "playing" | `scene-${number}` | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playPreview = useCallback(async (text: string, vn: string, key: "loading" | `scene-${number}`) => {
    setPreviewingVoice(key);
    try {
      audioRef.current?.pause();
      const r = await fetch("/api/tts/preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voiceName: vn }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "试听失败");
      const audio = new Audio(URL.createObjectURL(await r.blob()));
      audioRef.current = audio;
      audio.onended = () => setPreviewingVoice(null);
      await audio.play(); setPreviewingVoice("playing");
    } catch (e) { alert((e as Error).message); setPreviewingVoice(null); }
  }, []);
  const previewSceneVoice = (i: number) => {
    const s = script?.scenes[i]; if (s?.narration) void playPreview(s.narration, voiceName, `scene-${i}`);
  };

  const rows = csv.trim() ? csv.trim().split("\n").length - 1 : 0;
  const rendering = job && !["done", "failed"].includes(job.status);
  const renderPct = job?.renderPercent ?? 0;
  const allVoices = [...PRESET_VOICES, ...enginePresetVoices(engines)];

  return (
    <div className="container">
      <div className="topbar">
        <div>
          <h1>{t("app.title")}</h1>
          <p className="subtitle">{t("app.subtitle")}</p>
        </div>
        <div className="row">
            <select className="text-input lang-select" value={lang} onChange={(e) => setLang(e.target.value as never)} title={t("language.label")}>
              <option value="zh-CN">中文</option>
              <option value="en">English</option>
            </select>
            <button className="ghost" onClick={() => setSettingsOpen(true)}>{t("app.settings")}</button>
          </div>
      </div>

      {settingsOpen && (
        <SettingsModal engines={engines} tab={settingsTab} setTab={setSettingsTab} onClose={() => setSettingsOpen(false)} />
      )}

      <div className="steps">
        {([1, 2, 3, 4] as const).map((s) => (
          <div key={s} className={`step-chip ${step === s ? "active" : step > s ? "done" : ""}`}>
            {t(`steps.s${s}`)}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="card">
          <h2>{t("step1.title")}</h2>
          <div className="row" style={{ marginBottom: 12 }}>
            <label className={`mode-tab ${csvMode === "paste" ? "on" : ""}`} onClick={() => setCsvMode("paste")}>{t("step1.paste")}</label>
            <label className={`mode-tab ${csvMode === "upload" ? "on" : ""}`} onClick={() => setCsvMode("upload")}>{t("step1.upload")}</label>
          </div>
          {csvMode === "paste" ? (
            <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setValidation(null); }} spellCheck={false} />
          ) : (
            <div className="upload-zone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void onFileChosen(f); }}>
              <input id="csv-file" type="file" accept=".csv,.txt,text/csv" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFileChosen(f); }} />
              <p style={{ fontSize: 16, marginBottom: 8 }}>{t("step1.dropHere")}</p>
              <button className="ghost" onClick={() => document.getElementById("csv-file")?.click()}>{t("step1.chooseFile")}</button>
              {csv && <p className="hint" style={{ marginTop: 12 }}>{t("step1.loadedRows", { rows: csv.split("\n").length - 1 })}</p>}
            </div>
          )}
          {validation && (
            <div className={validation.ok ? "valid-box" : "error-box"}>
              {validation.ok ? (
                <>{t("step1.valid", { rows: validation.rowCount ?? 0, cols: validation.columns?.length ?? 0, numeric: validation.numericCols?.join(", ") || "—" })}
                  {validation.warnings?.map((w, i) => <div key={i} style={{ color: "#fbbf24" }}>⚠ {w}</div>)}
                </>
              ) : <>❌ {validation.error}</>}
            </div>
          )}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="primary" disabled={rows < 2 || validating} onClick={goStep2}>
              {validating ? t("step1.validating") : t("step1.next")}
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <>
          <div className="card">
            <h2>{t("step2.title")}</h2>
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="subtitle" style={{ margin: 0 }}>{t("step2.quality")}</span>
              <label className="radio"><input type="radio" checked={quality === "draft"} onChange={() => setQuality("draft")} />{t("step2.draft")}</label>
              <label className="radio"><input type="radio" checked={quality === "standard"} onChange={() => setQuality("standard")} />{t("step2.standard")}</label>
            </div>
            <div className="row">
              <span className="subtitle" style={{ margin: 0 }}>{t("step2.themeHint")}</span>
              <input className="text-input" value={titleHint} onChange={(e) => setTitleHint(e.target.value)} placeholder={t("step2.themeHintPh")} />
            </div>
          </div>
          <div className="row">
            <button className="ghost" onClick={() => setStep(1)}>{t("step2.back")}</button>
            <button className="primary" disabled={previewing} onClick={generateDraft}>
              {previewing ? t("step2.drafting") : t("step2.draftBtn")}
            </button>
          </div>
          {previewError && <div className="error-box">{previewError}</div>}
        </>
      )}

      {step === 3 && script && (
        <>
          <div className="card">
            <h2>
              {t("step3.title")}
              <span style={{ float: "right", color: "var(--muted)", fontSize: 13 }}>{t("step3.allEditable")}</span>
            </h2>

            <div className="edit-block">
              <label className="edit-label">{t("step3.videoTitle")}</label>
              <input className="text-input" value={script.title} onChange={(e) => setScript({ ...script, title: e.target.value })} />
            </div>

            <div className="edit-block">
              <label className="edit-label">{t("step3.themeStyle")}</label>
              <div className="theme-grid">
                {THEMES.map((t) => (
                  <button key={t.id} className={`theme-card ${script.theme === t.id ? "selected" : ""}`}
                    onClick={() => setScript({ ...script, theme: t.id })} title={t.hint}>
                    <video src={`/api/samples/${script.scenes[0]?.template ?? "kpi-headline"}/${t.id}`} autoPlay muted loop playsInline
                      onError={(e) => ((e.target as HTMLVideoElement).style.display = "none")} />
                    <span className="theme-name">{t.label}</span>
                    <span className="theme-hint">{t.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="edit-block">
              <label className="edit-label">{t("step3.voice")}</label>
              <div className="row">
                <select className="text-input voice-select" value={voiceName} onChange={(e) => setVoiceName(e.target.value)}>
                  {allVoices.map((v, i) => <option key={i} value={v.voiceName}>{v.label}</option>)}
                </select>
                <button className="ghost" disabled={previewingVoice !== null}
                  onClick={() => playPreview("大家好，这是配音音色试听效果，数据不会说谎。", voiceName, "loading")}>
                  {previewingVoice === "loading" ? t("step3.synthesizing") : previewingVoice === "playing" ? t("step3.playing") : t("step3.preview")}
                </button>
              </div>
            </div>

            <div className="edit-block">
              <label className="edit-label">
                {t("step3.scenes", { count: script.scenes.length })}
                <span className="edit-subhint">{t("step3.scenesHint")}</span>
              </label>
              {script.scenes.map((s, i) => (
                <div className="scene-editor" key={i}>
                  <div className="scene-head">
                    <span className="scene-num">#{i + 1}</span>
                    <select className="tpl-select" value={s.template}
                      title={`换模板：${templates.find((t) => t.id === s.template)?.hint ?? ""}`}
                      onChange={(e) => patchScene(i, { template: e.target.value })}>
                      {templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.hint}</option>)}
                    </select>
                    <div className="tpl-preview">
                      <video src={`/api/samples/${s.template}/${script.theme}`} autoPlay muted loop playsInline
                        onError={(e) => ((e.target as HTMLVideoElement).style.display = "none")} />
                    </div>
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label className="edit-label">{t("step3.sceneHeadline")}</label>
                      <input className="text-input" value={s.headline} onChange={(e) => patchScene(i, { headline: e.target.value })} placeholder={t("step3.sceneHeadlinePh")} />
                    </div>
                    <div className="field">
                      <label className="edit-label">{t("step3.sceneSubline")}</label>
                      <input className="text-input" value={s.subline} onChange={(e) => patchScene(i, { subline: e.target.value })} placeholder={t("step3.sceneSublinePh")} />
                    </div>
                  </div>
                  <div className="field">
                    <label className="edit-label">
                      {t("step3.sceneNarration")}
                      <button className="link-btn" onClick={() => previewSceneVoice(i)} disabled={previewingVoice === `scene-${i}`}>
                        {previewingVoice === `scene-${i}` ? t("step3.synthesizing") : t("step3.listenThis")}
                      </button>
                    </label>
                    <textarea className="narration-input" value={s.narration} onChange={(e) => patchScene(i, { narration: e.target.value })} rows={2} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="row">
            <button className="ghost" onClick={() => setStep(2)}>{t("step3.back")}</button>
            <button className="primary" onClick={startJob}>{t("step3.confirm")}</button>
          </div>
        </>
      )}

      {step === 4 && job && (
        <div className="card">
          <h2>
            {rendering ? t("step4.working") : job.status === "done" ? t("step4.done") : t("step4.failed")}
            <span style={{ float: "right", color: "var(--muted)", fontSize: 14 }}>{t("step4.taskId", { id: job.jobId })}</span>
          </h2>
          <div className="progress-bar">
            <div className="progress-fill" style={{
              width: `${job.status === "done" ? 100 : job.status === "failed" ? 100 : Math.max(job.progress, renderPct > 0 ? 50 + renderPct * 0.4 : job.progress)}%`,
              background: job.status === "failed" ? "var(--accent2)" : "var(--accent)",
            }} />
          </div>
          <div className="status-line">
            <span>{t(`status.${job.status}`)} {job.message ? `· ${job.message}` : ""}</span>
            <span>{rendering && renderPct > 0 ? t("step4.rendering", { pct: renderPct }) : `${job.progress}%`}</span>
          </div>
          {job.status === "failed" && <div className="error-box">{job.error}</div>}
          {job.status === "done" && job.downloads && (
            <>
              <video className="result" src={`/api/jobs/${job.jobId}/download/video`} controls />
              <div className="dl-row">
                <a href={`/api/jobs/${job.jobId}/download/video`} download><button className="primary">{t("step4.downloadVideo")}</button></a>
                <a href={`/api/jobs/${job.jobId}/download/project`} download><button className="ghost">{t("step4.downloadProject")}</button></a>
                <button className="ghost" onClick={() => { setJob(null); setStep(3); }}>{t("step4.redo")}</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- 设置弹窗（TTS / LLM）----------------
function SettingsModal({ engines, tab, setTab, onClose }: {
  engines: EngineInfo[];
  tab: "tts" | "llm";
  setTab: (t: "tts" | "llm") => void;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<{
    llm: { provider: string; apiKey?: string; baseUrl?: string; model?: string };
    tts: Record<string, Record<string, unknown>>;
  } | null>(null);
  const { t } = useI18n();
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>("");

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then(setSettings).catch(() => {});
  }, []);

  const save = async () => {
    if (!settings) return;
    await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  };

  const testLlm = async () => {
    if (!settings) return;
    setTesting(true); setTestResult("");
    try {
      const r = await fetch("/api/llm/test", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...settings.llm, save: true }),
      });
      const d = await r.json();
      setTestResult(d.ok ? t("settings.testOk", { model: d.model, ms: d.elapsedMs }) : `❌ ${d.error}`);
    } catch (e) { setTestResult(`❌ ${(e as Error).message}`); } finally { setTesting(false); }
  };

  if (!settings) return <div className="modal-mask"><div className="modal">加载中…</div></div>;

  const llm = settings.llm;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t("settings.title")}</h2>
          <button className="ghost" onClick={onClose}>{t("settings.close")}</button>
        </div>
        <div className="tabs">
          <button className={`tab ${tab === "tts" ? "on" : ""}`} onClick={() => setTab("tts")}>{t("settings.tabTts")}</button>
          <button className={`tab ${tab === "llm" ? "on" : ""}`} onClick={() => setTab("llm")}>{t("settings.tabLlm")}</button>
        </div>

        {tab === "tts" && (
          <div className="engines-list">
            <p className="hint" style={{ marginBottom: 12 }}>
              {t("settings.ttsHint")}
            </p>
            {engines.map((e) => {
              const cfg = settings.tts[e.id] ?? {};
              const setCfg = (patch: Record<string, unknown>) =>
                setSettings({ ...settings, tts: { ...settings.tts, [e.id]: { ...cfg, ...patch } } });
              return (
                <div className="engine-card" key={e.id}>
                  <div className="engine-head">
                    <b>{e.label}</b>
                    <span className="engine-tag">{e.free ? t("settings.free") : e.selfHosted ? t("settings.selfHosted") : t("settings.needsKey")}</span>
                  </div>
                  {(e.needsKey || e.fields.length > 0) && (
                    <div className="engine-fields">
                      {e.needsKey && (
                        <input className="text-input" type="password" placeholder={t("settings.apiKey")}
                          value={String(cfg.apiKey ?? "")} onChange={(ev) => setCfg({ apiKey: ev.target.value })} />
                      )}
                      {e.fields.map((f) => (
                        <input key={f.key} className="text-input" placeholder={`${f.label}${f.placeholder ? `：${f.placeholder}` : ""}`}
                          value={String(cfg[f.key] ?? "")} onChange={(ev) => setCfg({ [f.key]: ev.target.value })} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tab === "llm" && (
          <div className="llm-form">
            <div className="row" style={{ marginBottom: 12 }}>
              <label className="radio">
                <input type="radio" checked={llm.provider === "openai"} onChange={() => setSettings({ ...settings, llm: { ...llm, provider: "openai" } })} />
                {t("settings.llmProviderOpenai")}
              </label>
              <label className="radio">
                <input type="radio" checked={llm.provider === "claude"} onChange={() => setSettings({ ...settings, llm: { ...llm, provider: "claude" } })} />
                {t("settings.llmProviderClaude")}
              </label>
            </div>
            <label className="edit-label">{t("settings.apiKey")}</label>
            <input className="text-input" type="password" placeholder="sk-…"
              value={String(llm.apiKey ?? "")} onChange={(e) => setSettings({ ...settings, llm: { ...llm, apiKey: e.target.value } })} />
            <label className="edit-label">{t("settings.baseUrl")}{llm.provider === "claude" ? ` (${t("settings.baseUrlClaudePh")})` : ""}</label>
            <input className="text-input" placeholder={llm.provider === "claude" ? t("settings.baseUrlClaudePh") : t("settings.baseUrlOpenaiPh")}
              value={String(llm.baseUrl ?? "")} onChange={(e) => setSettings({ ...settings, llm: { ...llm, baseUrl: e.target.value } })} />
            <label className="edit-label">{t("settings.model")}</label>
            <input className="text-input" placeholder={llm.provider === "claude" ? t("settings.modelClaudePh") : t("settings.modelOpenaiPh")}
              value={String(llm.model ?? "")} onChange={(e) => setSettings({ ...settings, llm: { ...llm, model: e.target.value } })} />
            <div className="row" style={{ marginTop: 12 }}>
              <button className="ghost" disabled={testing} onClick={testLlm}>{testing ? t("settings.testing") : t("settings.saveAndTest")}</button>
              {testResult && <span className={testResult.startsWith("✅") ? "ok-text" : "err-text"}>{testResult}</span>}
            </div>
          </div>
        )}

        <div className="modal-foot">
          {saved && <span className="ok-text">{t("settings.saved")}</span>}
          <button className="primary" onClick={save}>{t("settings.save")}</button>
        </div>
      </div>
    </div>
  );
}
