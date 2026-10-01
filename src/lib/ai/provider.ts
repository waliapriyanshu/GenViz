import type { LanguageModel } from "ai";
import "server-only";
import { createGroq } from "@ai-sdk/groq";
import { ConfigError } from "@/lib/errors";

/**
 * Provider abstraction. Business logic only ever asks for "the analyst model
 * chain"; which provider/model backs it is configuration:
 *
 *   LLM_PROVIDER=groq                 (default)
 *   LLM_MODEL=openai/gpt-oss-120b      (default)
 *   LLM_FALLBACK=groq:openai/gpt-oss-20b   (optional, comma-separated provider:model list)
 *
 * Adding a provider = adding a case to `createModel` (any AI SDK provider works).
 */

export interface ModelCandidate {
  provider: string;
  modelId: string;
  model: LanguageModel;
  /** Provider-specific options passed through generateText's providerOptions. */
  providerOptions: Record<string, Record<string, string | number | boolean>>;
}

export const DEFAULT_PROVIDER = "groq";
export const DEFAULT_MODEL = "openai/gpt-oss-120b";

function createModel(provider: string, modelId: string): ModelCandidate {
  switch (provider) {
    case "groq": {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new ConfigError("GROQ_API_KEY is not set.");
      // GROQ_BASE_URL is optional (e.g. an AI gateway/proxy in front of Groq).
      const groq = createGroq({
        apiKey,
        baseURL: process.env.GROQ_BASE_URL || undefined,
      });
      return {
        provider,
        modelId,
        model: groq(modelId),
        providerOptions: {
          groq: {
            // gpt-oss is a reasoning model; low effort keeps latency and token use (rate limits) down.
            ...(modelId.startsWith("openai/gpt-oss")
              ? { reasoningEffort: "low" }
              : {}),
            parallelToolCalls: false,
          },
        },
      };
    }
    default:
      throw new ConfigError(`Unsupported LLM_PROVIDER "${provider}".`);
  }
}

export function primaryProviderName(): string {
  return (process.env.LLM_PROVIDER || DEFAULT_PROVIDER).trim();
}

/** Ordered list of models to try: primary first, then any configured fallbacks. */
export function getAnalystModelChain(): ModelCandidate[] {
  const chain = [
    createModel(
      primaryProviderName(),
      (process.env.LLM_MODEL || DEFAULT_MODEL).trim(),
    ),
  ];
  for (const entry of (process.env.LLM_FALLBACK ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator <= 0) continue;
    chain.push(
      createModel(entry.slice(0, separator), entry.slice(separator + 1)),
    );
  }
  return chain;
}
