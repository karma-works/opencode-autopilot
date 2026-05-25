import type { JudgeConfig, JudgeModel } from "./types.ts";

type HostedProvider = "anthropic" | "openai" | "google" | "openrouter" | "fireworks";

interface ProviderDef {
  readonly envKeys: readonly string[];
  readonly defaultModel: string;
  readonly endpoint: (model: string, key: string) => string;
  readonly headers: (key: string) => Record<string, string>;
  readonly body: (model: string, prompt: string) => unknown;
  readonly parseText: (response: unknown) => string;
}

function openaiBody(model: string, prompt: string): unknown {
  return { model, temperature: 0, messages: [{ role: "user", content: prompt }] };
}

function parseOpenAI(response: unknown): string {
  const choices = (response as { readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[] }).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Judge response did not include text content.");
  return content;
}

function parseAnthropic(response: unknown): string {
  const content = (response as { readonly content?: readonly { readonly type?: string; readonly text?: unknown }[] }).content;
  const text = content?.find((part) => part.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Anthropic judge response did not include text content.");
  return text;
}

function parseGoogle(response: unknown): string {
  const candidates = (response as { readonly candidates?: readonly { readonly content?: { readonly parts?: readonly { readonly text?: unknown }[] } }[] }).candidates;
  const text = candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") throw new Error("Google judge response did not include text content.");
  return text;
}

// Providers ordered by preference for automatic selection when no provider is specified.
// Models chosen for lowest cost while reliably following a structured JSON system prompt.
const PROVIDERS: Record<HostedProvider, ProviderDef> = {
  anthropic: {
    envKeys: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-haiku-4-5",
    endpoint: () => "https://api.anthropic.com/v1/messages",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    body: (model, prompt) => ({ model, max_tokens: 512, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    parseText: parseAnthropic,
  },
  openai: {
    envKeys: ["OPENAI_API_KEY"],
    defaultModel: "gpt-4o-mini",
    endpoint: () => "https://api.openai.com/v1/chat/completions",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: openaiBody,
    parseText: parseOpenAI,
  },
  google: {
    envKeys: ["GOOGLE_API_KEY"],
    defaultModel: "gemini-2.0-flash-lite",
    // Google embeds the model name and key in the URL rather than headers.
    endpoint: (model, key) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    headers: () => ({}),
    body: (_model, prompt) => ({ generationConfig: { temperature: 0 }, contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    parseText: parseGoogle,
  },
  // OpenRouter: OpenAI-compatible proxy. Default model is Llama 3.1 8B (paid tier).
  // For zero-cost prototyping use "meta-llama/llama-3.1-8b-instruct:free" (200 req/day limit).
  openrouter: {
    envKeys: ["OPENROUTER_API_KEY"],
    defaultModel: "meta-llama/llama-3.1-8b-instruct",
    endpoint: () => "https://openrouter.ai/api/v1/chat/completions",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: openaiBody,
    parseText: parseOpenAI,
  },
  // Fireworks AI: OpenAI-compatible, fast serverless inference.
  // Qwen3 8B is the cheapest model reliable enough for structured JSON output (~$0.20/M tokens).
  fireworks: {
    envKeys: ["FIREWORKS_API_KEY"],
    defaultModel: "accounts/fireworks/models/qwen3-8b",
    endpoint: () => "https://api.fireworks.ai/inference/v1/chat/completions",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: openaiBody,
    parseText: parseOpenAI,
  },
};

const SCAN_ORDER: readonly HostedProvider[] = ["anthropic", "openai", "google", "openrouter", "fireworks"];

function resolveKey(def: ProviderDef, override: string | null): string | null {
  if (override) return override;
  for (const envKey of def.envKeys) {
    const value = process.env[envKey];
    if (value) return value;
  }
  return null;
}

interface ProviderSelection {
  readonly def: ProviderDef;
  readonly key: string;
  readonly model: string;
}

function selectProvider(config: JudgeConfig): ProviderSelection | null {
  if (config.provider) {
    const def = PROVIDERS[config.provider as HostedProvider];
    if (!def) return null;
    const key = resolveKey(def, config.providerKey);
    if (!key) return null;
    return { def, key, model: config.model ?? def.defaultModel };
  }

  for (const id of SCAN_ORDER) {
    const def = PROVIDERS[id];
    const key = resolveKey(def, null);
    if (key) return { def, key, model: config.model ?? def.defaultModel };
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

export function createHostedJudgeModel(): JudgeModel {
  return {
    async complete(prompt: string, config: JudgeConfig): Promise<string> {
      const selection = selectProvider(config);
      if (!selection) {
        throw new Error(
          "No judge provider available. Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY, FIREWORKS_API_KEY."
        );
      }
      const { def, key, model } = selection;
      const url = def.endpoint(model, key);
      const response = await postJson(url, def.headers(key), def.body(model, prompt), config.timeoutMs);
      return def.parseText(response);
    }
  };
}
