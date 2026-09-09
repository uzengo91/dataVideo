# 开发计划 —— AI 数据解说短视频自动化工厂

> 前后端均为 Node 22 + TypeScript。工期按单人全职估算（兼职顺延）。
> 里程碑 M0-M2 为 MVP 骨架，M3 起可对外演示，M4 收口 MVP。

## 技术栈定版

| 层 | 选型 | 说明 |
|---|---|---|
| 后端框架 | Fastify 5 + TS（Node 22, ESM） | 轻量、原生 schema 校验、SSE 友好 |
| 任务队列 | BullMQ + Redis | 渲染任务重试/并发限流/进度事件；无 Redis 环境降级 p-queue |
| LLM 接入 | OpenAI SDK 指向 Ark 端点 | `baseURL=https://ark.cn-beijing.volces.com/api/coding/v3`，model=glm-5.3-flash；统一封装：JSON mode + 重试 + reasoning 预留 + Zod 校验 |
| 数据校验 | Zod | 场景脚本 schema、API 入参 |
| CSV | papaparse | 浏览器端解析 + 预览，后端复用 |
| 渲染 | `hyperframes` CLI（spawn，pinned 版本） | 每任务独立临时工作区 |
| TTS | Provider 接口：`macos-say` / `edge-tts`（edge-tts-node） | 默认自动探测；win/linux CI 用 edge-tts |
| 前端 | Next.js 15 + TS + Tailwind + shadcn/ui | 表单/时间线预览/进度/下载 |
| 状态推送 | SSE | 任务阶段事件（解析→脚本→TTS→渲染%→完成） |
| 存储 | 本地磁盘 `data/jobs/<id>/` | MVP 单机；工程包 zip 下载 |
| 测试 | Vitest + Playwright（冒烟） | 管线单测 + E2E 一条龙 |

## Monorepo 结构（pnpm workspace）

```
data-news/
  apps/
    server/          # Fastify API + 编排管线
    web/             # Next.js 前端
  packages/
    shared/          # Zod schema、类型、常量（前后端共用）
    llm/             # Ark 客户端封装：chat/json/toolCall + 重试 + 计费日志
    tts/             # TTS Provider 接口与实现（say/edge-tts）+ 时长探测
    templates/       # 10 套 HyperFrames 变量驱动模板 + manifest.json + 预览缩略图
    pipeline/        # ingest → script → tts → compose → render → verify 编排
```

## 模板清单（M3 交付，全部变量驱动）

每套模板 = `index.html`（可独立预览）+ `manifest.json`（变量 schema、适用数据形态、时长弹性区间）。数据一律经 `data-composition-variables` + `getVariables()` 注入，禁止内嵌数据。

1. `kpi-headline` — 大字 KPI + 同比增幅（财报开场）
2. `bar-race` — 柱状竞赛图（分类对比随时间演变）
3. `line-trend` — 折线趋势 + 关键点标注
4. `donut-share` — 环形份额图
5. `waterfall` — 瀑布图（利润桥/归因）
6. `geo-map` — 地图填色（区域数据，跨境电商）
7. `data-table-reveal` — 报表逐行揭示（原表数据感）
8. `compare-split` — 左右对比（A/B、同比/环比）
9. `number-counter` — 数字滚动（0→目标值）
10. `quote-insight` — 结论金句卡（AI 总结句）

## 里程碑

### M0 — 地基与管道打通（3 天）
- pnpm monorepo 初始化；shared/llm/tts 包骨架
- llm 包：Ark 客户端（chat/completions、JSON mode、reasoning 预留、`finish_reason=length` 自动加倍重试）
- tts 包：say + edge-tts 双实现 + ffprobe 时长探测
- **验收**：一条 60 行脚本本地跑通 "CSV 文本 → LLM 场景脚本 JSON → VO.mp3"

### M1 — 渲染工厂核心（5 天）
- pipeline 包：`composeToWorkspace(templates, script)` 生成临时渲染目录（index.html 装配子组合、assets/vo.mp3 固定路径写死）
- spawn `hyperframes check`（门禁）→ `render --variables --fps 60`；stdout 进度解析
- BullMQ 队列 + 并发限流（默认 2）+ 失败重试（lint 输出回喂 LLM 修复模板变量，最多 2 次）
- **验收**：命令行 `pnpm demo` 输入示例 CSV → 输出含音轨的 1080p60 MP4；600 帧渲染 < 60s

### M2 — API 服务（3 天）
- Fastify：`POST /api/jobs`（csv 文本 + 模板偏好 + 音色）→ jobId；`GET /api/jobs/:id`（状态）；`GET /api/jobs/:id/events`（SSE）；`GET /api/jobs/:id/download`
- 磁盘任务存储；渲染产物 + 工程包 zip
- **验收**：curl 全流程可用

### M3 — 模板库 10 套（7 天，可与 M2 并行）
- 从官方 Catalog（data-chart 等）改造 + 自研，统一变量契约与设计系统（深色金融风 + 浅色科技风两套主题 token）
- 每套模板：单测（snapshot 渲染不报错）+ 缩略图 + manifest
- **验收**：10 套模板 × 2 主题 × 示例数据批量渲染通过 `--batch`

### M4 — Web 前端（5 天）
- 三步向导：① 粘贴 CSV（表格预览 + 列类型推断）② 脚本确认（场景列表可编辑解说词/换模板，重生成单场景）③ 渲染进度（SSE 阶段条 + 预览 snapshot 图）→ 成片播放 + 下载（MP4/工程包）
- **验收**：非技术用户 5 分钟内从粘贴到出片

### M5 — MVP 收口（2 天）
- 一键启动脚本（`pnpm dev` 起 server+web；`pnpm setup` 检查 ffmpeg/Chrome/edge-tts）
- 冒烟 E2E（Playwright）：粘贴→出片 happy path
- README + 示例数据集（财务/电商/科技各 1 份）
- **验收**：全新机器 15 分钟内可复现

## 里程碑时间线

```
周1: M0 ███ + M1 █████
周2: M1 ▸ + M2 ███ + M3 ████
周3: M3 ▸ + M4 █████
周4: M5 ██ → MVP 交付（约 3.5-4 周全职）
```

## 关键实现片段（已验证的写法）

模板变量声明与读取：
```html
<div data-composition-id="kpi" data-composition-variables='{"kpi":"0","delta":"+0%","voSrc":""}'>
```
```js
const v = window.__hyperframes.getVariables();   // CLI --variables 注入
document.getElementById('kpi').textContent = v.kpi;
```
渲染调用（后端 spawn）：
```bash
hyperframes render . --fps 60 --quality standard \
  --variables '{"kpi":"¥4.28 亿","delta":"+23%","audioFile":"assets/vo.mp3"}' \
  -o renders/out.mp4
```

## MVP 后路线（不进本期）

OCR 抽帧数字复核（自动保真报告）→ BGM 与节拍对齐 → edge-tts 多音色/多语言 → 云端批量（`--batch` + Lambda renderer）→ 用户自定义模板上传 → 账号与配额。
