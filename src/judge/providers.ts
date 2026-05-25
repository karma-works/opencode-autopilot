import type { JudgeConfig, JudgeModel } from "./types.ts";

interface HostedJudgeSelection {
  readonly provider: "anthropic" | "openai" | "google";
  readonly model: string;
}

function selectHostedJudge(config: JudgeConfig): HostedJudgeSelection | null {
  if (config.provider === "anthropic" || (!config.provider && process.env.ANTHROPIC_API_KEY)) {
    return { provider: "anthropic", model: config.model ?? "claude-haiku-4-5" };
  }
  if (config.provider === "openai" || (!config.provider && process.env.OPENAI_API_KEY)) {
    return { provider: "openai", model: config.model ?? "gpt-4o-mini" };
  }
  if (config.provider === "google" || (!config.provider && process.env.GOOGLE_API_KEY)) {
    return { provider: "google", model: config.model ?? "gemini-2.0-flash-lite" };
  }
  return null;
}

async function postJson(url: string, headers: HeadersInit, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`judge provider returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function textFromOpenAI(response: unknown): string {
  const choices = (response as { readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[] }).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI judge response did not include text content.");
  return content;
}

function textFromAnthropic(response: unknown): string {
  const content = (response as { readonly content?: readonly { readonly type?: string; readonly text?: unknown }[] }).content;
  const text = content?.find((part) => part.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Anthropic judge response did not include text content.");
  return text;
}

function textFromGoogle(response: unknown): string {
  const candidates = (response as { readonly candidates?: readonly { readonly content?: { readonly parts?: readonly { readonly text?: unknown }[] } }[] }).candidates;
  const text = candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") throw new Error("Google judge response did not include text content.");
  return text;
}

export function createHostedJudgeModel(): JudgeModel {
  return {
    async complete(prompt: string, config: JudgeConfig): Promise<string> {
      const selection = selectHostedJudge(config);
      if (!selection) throw new Error("No supported judge provider is configured. Set autoMode.judge.provider/model and the matching API key.");

      if (selection.provider === "anthropic") {
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) throw new Error("ANTHROPIC_API_KEY is required for the Anthropic judge.");
        const response = await postJson(
          "https://api.anthropic.com/v1/messages",
          { "x-api-key": key, "anthropic-version": "2023-06-01" },
          { model: selection.model, max_tokens: 512, temperature: 0, messages: [{ role: "user", content: prompt }] },
          config.timeoutMs
        );
        return textFromAnthropic(response);
      }

      if (selection.provider === "openai") {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new Error("OPENAI_API_KEY is required for the OpenAI judge.");
        const response = await postJson(
          "https://api.openai.com/v1/chat/completions",
          { Authorization: `Bearer ${key}` },
          { model: selection.model, temperature: 0, messages: [{ role: "user", content: prompt }] },
          config.timeoutMs
        );
        return textFromOpenAI(response);
      }

      const key = process.env.GOOGLE_API_KEY;
      if (!key) throw new Error("GOOGLE_API_KEY is required for the Google judge.");
      const response = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${selection.model}:generateContent?key=${encodeURIComponent(key)}`,
        {},
        { generationConfig: { temperature: 0 }, contents: [{ role: "user", parts: [{ text: prompt }] }] },
        config.timeoutMs
      );
      return textFromGoogle(response);
    }
  };
}
