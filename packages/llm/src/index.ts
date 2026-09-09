import OpenAI from "openai";
import type { ZodType } from "zod";

export interface LlmOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  usage: { promptTokens: number; completionTokens: number; reasoningTokens: number };
  finishReason: string;
  elapsedMs: number;
}

/** Ark(GLM) 客户端：OpenAI 兼容协议。GLM-5.3-flash 是推理模型（无法关闭 thinking），
 *  因此 max_tokens 必须预留 reasoning 空间；遇到 finish_reason=length 自动加倍重试。 */
export class ArkClient {
  private client: OpenAI;
  readonly model: string;

  constructor(opts: LlmOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ARK_API_KEY;
    if (!apiKey) throw new Error("Missing ARK_API_KEY (set it in .env)");
    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseURL ?? process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/coding/v3",
    });
    this.model = opts.model ?? process.env.ARK_MODEL ?? "glm-5.3-flash";
  }

  /** 普通对话。minTokens 为期望的可见输出 token 下限，内部按倍数预留 reasoning 空间。
   *  429/5xx 自动指数退避重试。 */
  async chat(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    opts: { minTokens?: number; maxRetries?: number; temperature?: number } = {}
  ): Promise<ChatResult> {
    const { minTokens = 512, maxRetries = 3, temperature = 0.3 } = opts;
    let maxTokens = Math.max(minTokens * 4, 1024); // reasoning 预留 4x
    let last: ChatResult | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const t0 = Date.now();
      let res: OpenAI.Chat.Completions.ChatCompletion;
      try {
        res = await this.client.chat.completions.create({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          temperature,
        });
      } catch (e) {
        const status = (e as { status?: number }).status;
        const retryable = status === 429 || (status ?? 500) >= 500;
        if (retryable && attempt < maxRetries) {
          const backoff = 1500 * Math.pow(2, attempt) + Math.random() * 800;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw e;
      }
      const choice = res.choices[0];
      const msg = choice.message;
      const details = (res.usage?.completion_tokens_details ?? {}) as { reasoning_tokens?: number };
      const result: ChatResult = {
        content: msg.content ?? "",
        reasoning: (msg as { reasoning_content?: string }).reasoning_content ?? "",
        usage: {
          promptTokens: res.usage?.prompt_tokens ?? 0,
          completionTokens: res.usage?.completion_tokens ?? 0,
          reasoningTokens: details.reasoning_tokens ?? 0,
        },
        finishReason: choice.finish_reason ?? "stop",
        elapsedMs: Date.now() - t0,
      };
      if (result.finishReason !== "length") return result;
      last = result;
      maxTokens *= 2; // 被截断：加倍重试
    }
    return last!;
  }

  /** JSON 模式 + Zod 校验。校验失败会把错误回喂给模型重试。 */
  async json<T>(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    schema: ZodType<T>,
    opts: { minTokens?: number; maxRetries?: number; temperature?: number } = {}
  ): Promise<{ data: T; meta: ChatResult }> {
    const maxRetries = opts.maxRetries ?? 3;
    const convo = [...messages];
    let meta: ChatResult | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await this.chat(convo, { ...opts, maxRetries: 0 });
      meta = res;
      const parsed = extractJson(res.content);
      if (parsed !== undefined) {
        const check = schema.safeParse(parsed);
        if (check.success) return { data: check.data, meta: res };
        convo.push({ role: "assistant", content: res.content });
        convo.push({
          role: "user",
          content: `你的 JSON 未通过校验，错误如下：\n${check.error.issues
            .map((i) => `- ${i.path.join(".")}: ${i.message}`)
            .join("\n")}\n请只输出修正后的完整 JSON，不要任何其他文字。`,
        });
      } else {
        convo.push({ role: "assistant", content: res.content });
        convo.push({
          role: "user",
          content: "无法从上面的输出中提取 JSON。请只输出一个合法 JSON 对象，不要 markdown 代码块，不要解释。",
        });
      }
    }
    throw new Error(`LLM JSON 解析失败（重试 ${maxRetries} 次后）: 最后输出片段: ${meta?.content.slice(0, 300)}`);
  }
}

/** 容错 JSON 提取：支持裸 JSON、```json 代码块、前后夹杂说明文字的情况 */
export function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  const candidates: string[] = [];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

  candidates.push(trimmed);

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      /* next */
    }
  }
  return undefined;
}
