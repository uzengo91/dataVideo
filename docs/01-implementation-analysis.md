# AI 数据解说短视频自动化工厂 —— 实现分析报告

> 调研日期：2026-09-08 ｜ 所有结论均基于本机实测，非推测

## 1. 可行性结论

**技术路线完全可行，且已用最小实验全链路打通。** HyperFrames 的确定性渲染特性（HTML/CSS/GSAP → 逐帧 seek 截图 → FFmpeg 编码）从根本上解决了 "Sora/Runway 数字幻觉" 痛点：图表是真实 DOM/SVG 渲染，数字 100% 精确，且每个场景是独立 HTML 片段，可按秒定位、按数据字段修改。

实测证据链：

| 环节 | 验证内容 | 结果 |
|---|---|---|
| HyperFrames 渲染 | 600 帧 @60fps 1080p | 38s 完成，输出 h264 1920×1080 精确 10.0s |
| 变量注入 | `--variables` JSON → 页面文本 | 中文 "Q3 营收增长 23%"、"¥4.28 亿" 正确渲染 |
| 音频混音 | `<audio>` 静态 src + clip 声明 | `hasAudio:true`，MP4 含音轨 |
| LLM 连通 | Ark OpenAI 兼容端点 | chat / JSON mode / tool calling 全部可用 |
| TTS | macOS `say`（Tingting 中文音色） | 免费可用，可插拔升级 |
| 质检 | `hyperframes check` | lint+运行时+布局+动效+对比度一键通过 |

## 2. 关键技术事实（实测）

### 2.1 HyperFrames（github.com/heygen-com/hyperframes）
- 47.1k stars，Apache 2.0，TypeScript monorepo，Node 22+（本机 v22.18.0 满足），依赖 FFmpeg（本机 7.1.1 满足）
- 渲染即真相：headless Chrome 逐帧 seek + FFmpeg 编码，相同输入必然相同输出
- **零构建**：`index.html` 即成品，浏览器直接可预览（这对调试极友好）
- 组件目录（Catalog）：`npx hyperframes add data-chart` 等命令安装现成块
- CLI：`init / lint / check / snapshot / preview / render / publish`，render 支持 `--variables`、`--batch`、`--workers`、`--fps 60`、`--quality draft|standard|high`
- 首次渲染自动下载 Chrome（93MB，一次性）

### 2.2 项目结构（极简，非常适合程序化生成）
```
project/
  index.html            # 主组合：声明时长/分辨率/变量定义
  compositions/         # 子组合（如 data-chart.html），通过 data-composition-src 挂载
  assets/               # 音频等资源
  hyperframes.json      # 注册表与路径配置
```
组合契约：`class="clip"` + `data-start` / `data-duration` / `data-track-index`；动画为挂在 `window.__timelines` 上的 paused GSAP timeline。

### 2.3 三个决定性工程细节（踩坑实测）
1. **音频必须是静态 src**：JS 运行时 setAttribute 无效，引擎在解析期读取 `src`。→ 方案：TTS 输出统一写到 `assets/vo.mp3` 固定路径，模板里写死引用，变量只改数据不改路径。
2. **数据注入优先用 `--variables` 而非改 HTML**：组件声明 `data-composition-variables` 默认值，脚本内 `window.__hyperframes.getVariables()` 读取。CLI 传 JSON 即可换数据，模板文件零改动、可复用、可批量（`--batch` 天然支持一个模板 × N 组数据）。
3. **LLM 不写代码，只写数据**：官方 data-chart 组件把数据内嵌为 JS 数组（AI 直接改代码 = 不可控）。工厂模式应把组件改造为 "变量驱动"：LLM 只产出符合 schema 的 JSON（场景脚本 + 图表数据 + 解说词），渲染由确定性模板完成。这是 "无幻觉" 的第二重保障。

### 2.4 LLM（Ark / GLM-5.3-Flash）
- 端点 `https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions`，`Authorization: Bearer` 头（注意：`x-api-key` 的 Anthropic 风格端点鉴权失败，用 OpenAI 风格）
- JSON mode（`response_format: json_object`）✅，tool calling ✅
- **是推理模型**：先输出 `reasoning_content` 再输出 `content`；`thinking:{type:"disabled"}` 不被该模型支持。→ 管线必须预留 reasoning tokens（max_tokens 放大 3-4 倍），结构化抽取时只解析 `content` 字段并做 JSON 容错解析。

### 2.5 渲染性能基线（本机 M 系 10 核）
| 配置 | 耗时 |
|---|---|
| 10s@60fps standard | ~38s |
| 6s@30fps draft | ~8-13s |

粗略换算：1 分钟成片 ≈ 2-4 分钟渲染。`--workers` 默认多 Chrome 并行（每 worker ~256MB RAM），Web 服务并发渲染需按内存配额排队。

## 3. 系统架构

```
┌─────────── Web 前端 (Next.js + TS) ───────────┐
│ 粘贴 CSV/报表 → 选模板 → 预览时间线 → 任务进度 → 成片下载 │
└──────────────────┬───────────────────────────┘
                   │ REST + SSE
┌──────────────────▼───────────── 后端 (Node 22 + Fastify + TS) ─────────────┐
│ ① Pipeline Orchestrator（任务队列，BullMQ + Redis 或进程内 P-queue）        │
│ ② Ingestion：CSV 解析(papaparse) + 类型推断 + LLM 辅助列语义识别            │
│ ③ Script Planner（LLM Call#1）：数据摘要 → 场景脚本 JSON（schema 校验）     │
│ ④ Copywriter（LLM Call#2）：每场景解说词（≤N 字，数字必须引自源数据）        │
│ ⑤ TTS Provider（可插拔）：macOS say（本地免费）/ edge-tts / 云厂商，     │
│    输出 assets/vo.mp3 + 时长探测(ffprobe) → 反推每场景 data-duration       │
│ ⑥ Composer：模板(10 套) + 变量 JSON → 生成渲染工作区 → 挂载子组合           │
│ ⑦ Renderer：spawn `hyperframes render --variables ... --fps 60`            │
│    + check 前置质检 + 失败自动重试（附 lint 输出回喂 LLM 修复）             │
│ ⑧ 数字保真校验：抽取成片时间轴上的关键帧，OCR 复核关键数字 == 源数据（MVP+） │
└────────────────────────────────────────────────────────────────────────────┘
```

**无幻觉的三重保障**：图表/文字 = 确定性 DOM 渲染；LLM 输出 = 受 schema 约束的纯数据；成片 = 渲染前后数字一致性校验。

## 4. 核心数据契约（Schema v1）

LLM Call#1 产出的脚本对象（Zod 校验，失败自动重试）：

```jsonc
{
  "title": "Q3 财报解读",
  "voice": "zh-female-1",
  "scenes": [
    {
      "template": "kpi-headline",          // 模板库 ID
      "narration": "第三季度营收 4.28 亿，同比增长 23%。", // 送 TTS
      "data": { "kpi": "4.28亿", "delta": "+23%", "label": "Q3 营收" }, // 变量，必须引用源数据
      "sourceRefs": ["revenue_q3"]          // 数字溯源字段（校验用）
    }
  ]
}
```

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| GLM 推理 token 超限截断 | max_tokens 预留 3-4×；`finish_reason=length` 自动重试加倍 |
| LLM 编造数字 | prompt 强约束 "只允许引用给定数据字段" + sourceRefs 溯源 + （MVP+）OCR 抽帧复核 |
| 渲染并发内存（每 worker ~256MB） | 队列限流（默认并发 2），draft 快速预览 → standard 终稿两档 |
| 音频时长 ≠ 场景时长 | ffprobe 探测 VO 时长 → 动态生成 `data-duration`；预留 0.3s 场景缓冲 |
| 数据卡可读性 | 沿用官方 check（布局/对比度/WCAG）作为渲染前置门禁 |
| CDN 依赖（GSAP/Google Fonts） | 渲染工作区本地化 assets（字体子集化 + npm 包内联 GSAP） |

## 6. MVP 范围裁定

**做**：CSV 粘贴 → LLM 脚本生成（schema 校验）→ 10 套变量驱动模板 → TTS（say + edge-tts 双实现）→ 1080p60 渲染导出 MP4 → 任务进度（SSE）→ 成片/工程下载（HTML 工程包一并导出，用户可手工微调后重渲）。
**不做（二期）**：多语言配音、BGM 自动选曲、OCR 复核、用户自建模板、Lambda 分布式渲染、账号体系（单租户即可）。
