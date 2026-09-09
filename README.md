# AI 数据解说短视频自动化工厂（data-news）

粘贴 CSV → AI 生成脚本与配音 → 确定性渲染 **无幻觉 1080p60 数据解说视频**。

基于 [HyperFrames](https://github.com/heygen-com/hyperframes)（代码驱动视频渲染）：图表为真实 DOM/SVG 渲染，数字 100% 精确、可按场景定位修改——解决扩散模型生成图表的文字扭曲与数字幻觉问题。

## 架构

```
apps/
  server/    Fastify API（任务队列/SSE 进度/产物下载）
  web/       React 三步向导（粘贴 CSV → 设定 → 出片）
packages/
  shared/    Zod schema（脚本/表格/任务事件）
  llm/       Ark(GLM) 客户端（JSON mode + 429 退避 + 校验回喂）
  tts/       macOS say / edge-tts 双实现 + ffprobe 时长探测
  templates/ 10 套变量驱动模板 + manifest 契约
  pipeline/  ingest → script → tts → compose → render → verify
```

**无幻觉三重保障**：图表 = 确定性 DOM 渲染；LLM 只产出受 schema 约束的数据（禁止写代码）；渲染前 `hyperframes check` 质检门禁。

## 快速开始

```bash
pnpm install
pnpm setup                 # 环境自检（node/ffmpeg/TTS/LLM 连通性）
cp .env.example .env       # 填入 ARK_API_KEY（已内置默认值）

pnpm dev:server            # 终端 1：API @ :8787
pnpm dev:web               # 终端 2：Web @ :3000
# 浏览器打开 http://localhost:3000，粘贴 CSV，三步出片
```

## 命令行方式（不开 Web）

```bash
pnpm demo                                        # M0: CSV → 脚本 JSON → 配音
pnpm --filter @data-news/pipeline demo:video examples/finance-half-year.csv   # 全流程出片
```

产物在 `data/<jobId>/`：`video.mp4`（1080p60 含音轨）、`script.json`、`project.zip`（HyperFrames 工程包，可手工微调后重渲）。

## 模板库（10 套 × 2 主题）

| ID | 用途 |
|---|---|
| kpi-headline | KPI 大字 + 同比增幅 |
| number-counter | 数字滚动 0→目标 |
| line-trend | 折线趋势 + 峰值标注 |
| bar-race | 分类柱状对比 |
| donut-share | 环形份额构成 |
| waterfall | 利润桥/归因瀑布 |
| geo-map | 区域榜单 |
| data-table-reveal | 原始报表逐行揭示 |
| compare-split | 左右对比 |
| quote-insight | 结论金句卡 |

主题：`dark-finance`（深色金融）/ `light-tech`（浅色科技）。
批量验收：`npx tsx packages/pipeline/src/verify-templates.ts`（10×2 全渲染校验）。

## API

| 方法/路径 | 说明 |
|---|---|
| `GET /api/health` | 健康检查 |
| `GET /api/templates` | 模板清单 |
| `POST /api/jobs` | 创建任务 `{csv, titleHint?, theme?, voice?, templates?, quality?}` |
| `GET /api/jobs/:id` | 查询状态/脚本/下载地址 |
| `GET /api/jobs/:id/events` | SSE 进度流 |
| `GET /api/jobs/:id/download/video\|project` | 下载成片/工程包 |

## 测试

```bash
pnpm test        # 各包单测（schema/CSV 解析/JSON 容错/音频探测/模板契约）
```

## 配音引擎与 AI 配置

应用内置 **⚙ 设置** 面板（本地软件模式，服务启动后自动打开浏览器）：

**配音引擎（TTS）** — 命名与 [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) 一致：

| 引擎 | 费用 | 说明 |
|---|---|---|
| azure-v1 (Edge TTS) | ✅ 免费 | 默认，无需 Key（`pip install edge-tts`） |
| omnivoice | ✅ 免费 | 本地神经网络语音（需 ~/omnivoice-env） |
| say | ✅ 免费 | macOS 内置 |
| azure-v2 | 需 Key | Azure Speech（key + region） |
| siliconflow | 需 Key | CosyVoice2 云 API |
| gemini | 有免费层 | Gemini TTS |
| mimo | 需 Key | 小米 MiMo（OpenAI 兼容 chat audio） |
| minimax | 需 Key | 站点可选 global/cn |
| elevenlabs | 有免费层 | multilingual_v2 |
| chatterbox / kokoro | ✅ 自托管 | OpenAI 兼容 /audio/speech |
| fish_audio | 需 Key | 支持 reference_id 音色克隆 |
| no-voice | — | 静音音轨 |

配置持久化在 `data/settings.json`（API Key 脱敏显示）。

**AI 脚本（LLM）** — 支持 **OpenAI 兼容**（GLM / DeepSeek / Kimi / OpenAI，可自定义 Base URL）与 **Claude（Anthropic）**，一键"保存并测试连通"。

## 打包发行（Windows / macOS 便携程序）

```bash
node build/build.mjs --target=all   # 或 mac / win
```

产物在 `build/release/`：

```
macos-arm64/  windows-x64/
  dataVideo-server(.exe)   单可执行（内嵌 Node 22）
  resources/web            前端（服务自动托管，单端口）
  resources/templates      模板 + 60 个主题样例视频 + gsap
  START.md                 启动说明
```

用户机器只需 **FFmpeg**（加入 PATH）：运行可执行文件后打开 `http://localhost:8787` 即用。
首次渲染自动下载 headless Chrome。下载地址见 GitHub Releases（附打包好的 zip）。

## 环境要求

- Node 22+，FFmpeg（含 libmp3lame）
- TTS：macOS 内置 `say`（中文音色"婷婷"）或跨平台 `pip install edge-tts`
- LLM：火山方舟 Ark 端点（OpenAI 兼容协议），见 `.env`
- 首次渲染自动下载 headless Chrome（~93MB，一次性）

## 已知约束（MVP）

- 单机单租户（无账号体系）；渲染并发默认 2（每 worker ~256MB）
- LLM 429 限流自动指数退避，高峰期任务排队时间会变长
- draft 档适合预览（约 1-2 分钟），正式成片用 standard（约 3-5 分钟）
