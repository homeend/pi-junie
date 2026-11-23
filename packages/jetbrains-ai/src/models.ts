import type { Api, Model } from "@earendil-works/pi-ai";

// Snapshot of Junie ModelOption.Specific; availability is enforced by Ingrazzio.
const snapshot: Model<Api>[] = [
  {
    "id": "gpt-5-2025-08-07",
    "name": "gpt-5-2025-08-07",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.25,
      "output": 10.0,
      "cacheRead": 0.125,
      "cacheWrite": 0
    },
    "contextWindow": 400000,
    "maxTokens": 32768
  },
  {
    "id": "gpt-5.3-codex",
    "name": "gpt-5.3-codex",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14.0,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "contextWindow": 400000,
    "maxTokens": 32768
  },
  {
    "id": "gpt-5.2-2025-12-11",
    "name": "gpt-5.2-2025-12-11",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14.0,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "contextWindow": 400000,
    "maxTokens": 32768
  },
  {
    "id": "gpt-5.4",
    "name": "gpt-5.4",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2.5,
      "output": 15.0,
      "cacheRead": 0.25,
      "cacheWrite": 0
    },
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "id": "gpt-5.5",
    "name": "gpt-5.5",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 5.0,
      "output": 30.0,
      "cacheRead": 0.5,
      "cacheWrite": 0
    },
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "id": "gpt-5.6-sol",
    "name": "gpt-5.6-sol",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 5.0,
      "output": 30.0,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    },
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "id": "gpt-6-astra",
    "name": "gpt-6-astra",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10.0,
      "output": 50.0,
      "cacheRead": 1.0,
      "cacheWrite": 12.5
    },
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "id": "gpt-5.6-terra",
    "name": "gpt-5.6-terra",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2.0,
      "output": 12.0,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    },
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "id": "gpt-5.6-luna",
    "name": "gpt-5.6-luna",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.2,
      "output": 1.2,
      "cacheRead": 0.02,
      "cacheWrite": 0.25
    },
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "id": "gpt-6-sol",
    "name": "gpt-6-sol",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2.0,
      "output": 10.0,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    },
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "id": "gpt-6.1-sol",
    "name": "gpt-6.1-sol",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2.0,
      "output": 10.0,
      "cacheRead": 0.1,
      "cacheWrite": 2.5
    },
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "id": "gpt-6-luna",
    "name": "gpt-6-luna",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "openai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.1,
      "output": 0.5,
      "cacheRead": 0.01,
      "cacheWrite": 0.125
    },
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "id": "claude-sonnet-4-6",
    "name": "claude-sonnet-4-6",
    "api": "anthropic-messages",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg",
    "headers": {
      "X-LLM-Model": "anthropic",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 3.0,
      "output": 15.0,
      "cacheRead": 0.3,
      "cacheWrite": 3.75
    },
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "id": "claude-sonnet-5",
    "name": "claude-sonnet-5",
    "api": "anthropic-messages",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg",
    "headers": {
      "X-LLM-Model": "anthropic",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2.0,
      "output": 10.0,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    },
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "id": "claude-sonnet-5-5",
    "name": "claude-sonnet-5-5",
    "api": "anthropic-messages",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg",
    "headers": {
      "X-LLM-Model": "anthropic",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2.0,
      "output": 10.0,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    },
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-4-6",
    "name": "claude-opus-4-6",
    "api": "anthropic-messages",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg",
    "headers": {
      "X-LLM-Model": "anthropic",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 5.0,
      "output": 25.0,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    },
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-4-7",
    "name": "claude-opus-4-7",
    "api": "anthropic-messages",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg",
    "headers": {
      "X-LLM-Model": "anthropic",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 5.0,
      "output": 25.0,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    },
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-4-8",
    "name": "claude-opus-4-8",
    "api": "anthropic-messages",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg",
    "headers": {
      "X-LLM-Model": "anthropic",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 5.0,
      "output": 25.0,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    },
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-5",
    "name": "claude-opus-5",
    "api": "anthropic-messages",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg",
    "headers": {
      "X-LLM-Model": "anthropic",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 5.0,
      "output": 25.0,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    },
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-5-5",
    "name": "claude-opus-5-5",
    "api": "anthropic-messages",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg",
    "headers": {
      "X-LLM-Model": "anthropic",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 4.0,
      "output": 20.0,
      "cacheRead": 0.2,
      "cacheWrite": 5.0
    },
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "id": "claude-fable-5",
    "name": "claude-fable-5",
    "api": "anthropic-messages",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg",
    "headers": {
      "X-LLM-Model": "anthropic",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10.0,
      "output": 50.0,
      "cacheRead": 1.0,
      "cacheWrite": 12.5
    },
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "id": "claude-fable-5-1",
    "name": "claude-fable-5-1",
    "api": "anthropic-messages",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg",
    "headers": {
      "X-LLM-Model": "anthropic",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10.0,
      "output": 50.0,
      "cacheRead": 0.25,
      "cacheWrite": 12.5
    },
    "contextWindow": 1000000,
    "maxTokens": 128000
  },
  {
    "id": "gemini-3.1-pro-preview",
    "name": "gemini-3.1-pro-preview",
    "api": "google-generative-ai",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1beta",
    "headers": {
      "X-LLM-Model": "google",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2.0,
      "output": 12.0,
      "cacheRead": 0.2,
      "cacheWrite": 0
    },
    "contextWindow": 1048576,
    "maxTokens": 32768
  },
  {
    "id": "gemini-3-flash-preview",
    "name": "gemini-3-flash-preview",
    "api": "google-generative-ai",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1beta",
    "headers": {
      "X-LLM-Model": "google",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.5,
      "output": 3.0,
      "cacheRead": 0.05,
      "cacheWrite": 0
    },
    "contextWindow": 1048576,
    "maxTokens": 32768
  },
  {
    "id": "gemini-3.6-flash",
    "name": "gemini-3.6-flash",
    "api": "google-generative-ai",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1beta",
    "headers": {
      "X-LLM-Model": "google",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.75,
      "output": 3.75,
      "cacheRead": 0.075,
      "cacheWrite": 0
    },
    "contextWindow": 1048576,
    "maxTokens": 32768
  },
  {
    "id": "gemini-3.7-flash",
    "name": "gemini-3.7-flash",
    "api": "google-generative-ai",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1beta",
    "headers": {
      "X-LLM-Model": "google",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.4,
      "output": 2.4,
      "cacheRead": 0.04,
      "cacheWrite": 0
    },
    "contextWindow": 1048576,
    "maxTokens": 32768
  },
  {
    "id": "gemini-3.8-flash",
    "name": "gemini-3.8-flash",
    "api": "google-generative-ai",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1beta",
    "headers": {
      "X-LLM-Model": "google",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.75,
      "output": 3.75,
      "cacheRead": 0.075,
      "cacheWrite": 0
    },
    "contextWindow": 1048576,
    "maxTokens": 32768
  },
  {
    "id": "gemini-3.1-flash-lite",
    "name": "gemini-3.1-flash-lite",
    "api": "google-generative-ai",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1beta",
    "headers": {
      "X-LLM-Model": "google",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.25,
      "output": 1.5,
      "cacheRead": 0.025,
      "cacheWrite": 0
    },
    "contextWindow": 1048576,
    "maxTokens": 32768
  },
  {
    "id": "gemini-3.5-flash-lite",
    "name": "gemini-3.5-flash-lite",
    "api": "google-generative-ai",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1beta",
    "headers": {
      "X-LLM-Model": "google",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.25,
      "output": 1.5,
      "cacheRead": 0.025,
      "cacheWrite": 0
    },
    "contextWindow": 1048576,
    "maxTokens": 32768
  },
  {
    "id": "grok-4.3",
    "name": "grok-4.3",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "grok",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "thinkingLevelMap": {
      "off": null,
      "minimal": null
    },
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.25,
      "output": 2.5,
      "cacheRead": 0.2,
      "cacheWrite": 0
    },
    "contextWindow": 1000000,
    "maxTokens": 32768
  },
  {
    "id": "grok-4.5",
    "name": "grok-4.5",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "grok",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "thinkingLevelMap": {
      "off": null,
      "minimal": null
    },
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2.0,
      "output": 6.0,
      "cacheRead": 0.3,
      "cacheWrite": 0
    },
    "contextWindow": 500000,
    "maxTokens": 32768
  },
  {
    "id": "grok-4.6",
    "name": "grok-4.6",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "grok",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "thinkingLevelMap": {
      "off": null,
      "minimal": null,
      "xhigh": "xhigh"
    },
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2.0,
      "output": 6.0,
      "cacheRead": 0.5,
      "cacheWrite": 0
    },
    "contextWindow": 500000,
    "maxTokens": 32768
  },
  {
    "id": "grok-4.7",
    "name": "grok-4.7",
    "api": "openai-responses",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "grok",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "thinkingLevelMap": {
      "off": null,
      "minimal": null,
      "xhigh": "xhigh"
    },
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2.0,
      "output": 6.0,
      "cacheRead": 0.5,
      "cacheWrite": 0
    },
    "contextWindow": 500000,
    "maxTokens": 32768
  },
  {
    "id": "Qwen/Qwen3.6-27B-FP8",
    "name": "Qwen/Qwen3.6-27B-FP8",
    "api": "openai-completions",
    "provider": "jetbrains-ai",
    "baseUrl": "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
    "headers": {
      "X-LLM-Model": "jbai",
      "X-Keep-Path": "true"
    },
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.15,
      "output": 0.9,
      "cacheRead": 0.015,
      "cacheWrite": 0.15
    },
    "contextWindow": 262144,
    "maxTokens": 32768
  }
];

export const JETBRAINS_AI_MODELS = snapshot.map((model) => ({
	...model,
	baseUrl: model.api === "google-generative-ai"
		? "https://ingrazzio-cloud-prod.labs.jb.gg/v1beta1/projects/jetbrains-grazie/locations/global/publishers/google"
		: model.headers?.["X-LLM-Model"] === "jbai"
			? "https://ingrazzio-cloud-prod.labs.jb.gg/llm/vllm/v1"
			: model.baseUrl,
}));
