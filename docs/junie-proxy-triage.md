# How Junie calls LLMs through AIR's proxy (triage)

Source: `junie-agent` at `ej-app/cli-standalone/activation/.../activation/`, mainly
`api/AcpConfiguredProxies.kt`, `api/AcpProxySource.kt`, `tbe/ConfiguredDirectProxyLLMAccess.kt`,
`api/AcpProxyModelDiscovery.kt`, `api/DirectProxyModelDiscovery.kt`, and `acp/session/providers/ProviderManagementHandler.kt`.
AIR side: `ultimate/plugins/air/frontend/llm/api/src/AirLlmGatewayRoutes.kt` and `shared/llm/src/AirLlmProvider.kt`.

## 1. Request URLs: plain vendor protocols with ACP base conventions

AIR's proxy is a pass-through. Each provider speaks its vendor's own wire protocol. The only convention to get
right is what the `baseUrl` from `providers/set` already contains. Junie uses `ConfiguredProxyPathFormat.Acp`:

| apiType | Junie request URL (`base` = baseUrl from `providers/set`) | Equivalent vendor URL | Vendor or JB? |
|---|---|---|---|
| `anthropic` | `base/v1/messages` | `https://api.anthropic.com/v1/messages` | vendor (base is the API root) |
| `openai` | `base/responses` or `base/chat/completions` (no `/v1`, unlike the `Standard` format) | `https://api.openai.com/v1/responses` | vendor; **base already ends at `/v1`** |
| `google` | `base/v1beta/models/{model}:generateContent` | Gemini API | vendor (base is the API root) |
| `vertex` | `base/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent` | Vertex AI | vendor. Project and location come from `_meta.vertex`, else the placeholder `default-project`/`default-location` |
| `xai` | `base/responses` | xAI | vendor |
| `qwen` | `base/chat/completions` | vLLM / OpenAI-compatible | vendor |
| `ingrazzio` | complete Ingrazzio path | — | **JB only** |

AIR confirms it (`AirLlmGatewayRoutes`): "Anthropic SDKs append `/v1/messages` to the base. OpenAI SDKs expect a
base that ends in `/v1`. Vertex SDKs append their versioned paths." BYOK OpenAI maps the proxy base to
`https://api.openai.com/v1`.

The OpenAI API is chosen per model (`ModelParameters.openAIApi`): Responses when the model supports it,
otherwise Chat Completions. The gpt-5.x/6.x models use Responses.

**Consequences for Pi:**
- `anthropic`: use the base as is. This already works.
- `openai`: use the base as is, so Pi's `openai-responses` requests `base/responses`. The `/v1` I added was
  wrong and caused `…/v1/v1/responses` (404).
- `google`: append `/v1beta`. Correct, matches Junie.
- `vertex`: Pi's `google-vertex` requested `base/v1/publishers/google/models/…` (express mode, no project).
  Junie uses `/v1/projects/{p}/locations/{l}/publishers/…`. **Needs a fix or a custom path.** Unverified.

## 2. Auth headers: JB convention on vendor protocols

- Junie sends the `providers/set` headers as given (`x-air-proxy-key`, `X-IntelliJ-Proxy-Agent-ID`). **JB**:
  the proxy authenticates the agent through these headers and injects the real credentials (JCP token or the
  BYOK key) upstream.
- Junie adds the vendor auth header (`Authorization: Bearer`, `x-api-key` for Anthropic, `api-key` for Azure)
  only when the configured headers lack it **and** it has its own JBA token. Over ACP it normally sends none.
- Pi always sends a vendor auth header with a placeholder key (`air-proxy`). Anthropic works with it. Whether
  the proxy overwrites or forwards `Authorization: Bearer air-proxy` to OpenAI/BYOK is **unverified**; if it
  forwards it, OpenAI rejects it with 401.

## 3. `providers/set` parameters: JB extensions

| Field | Meaning | JB or ACP |
|---|---|---|
| `providerId`, `apiType`, `baseUrl`, `headers` | proxy binding | ACP v1 standard (unstable providers) |
| `_meta.jetbrains.air.selectedModels` | models the user picked in AIR for this provider (BYOK). Junie restricts its catalog to them | **JB** |
| `_meta.vertex {projectId, location}` (or `_meta.claudeCode.vertex`) | Vertex resource location | **JB** |
| `_meta.junieFree` | only the free model is available | **JB** |
| `availableModels` (from config, not ACP) | JBAI id allowlist | **Junie** |

## 4. Model list: Junie asks the proxy, not only its static catalog

`AcpProxyModelDiscovery` runs on every binding change:

1. `openai` and `anthropic` first try the **JB account catalog**, `GET base/models/user`. This is **JB-specific**:
   the JCP gateway answers with the models the account may use. If it lists models, that list wins (restricted
   to `selectedModels` when present).
2. Otherwise the standard vendor listing: `base/models` (OpenAI, xAI, Qwen), `base/v1/models` (Anthropic),
   `base/v1beta/models` (Google), `base/v1beta1/publishers/google/models` (Vertex). This is **vendor**.
3. The listing is intersected with Junie's known models (`LLM.knownModels`). Wire names can differ from Junie's
   names (`wireNames`), and the request body's `model` is replaced with the listed name (extraBody). This is
   **Junie**.
4. When an Ingrazzio proxy is set, it wins over the others (`effective = ingrazzio.ifEmpty { all }`). **JB**.

While discovery is running, `discoveryPending` is true and the picker waits. That's why Junie sends
`config_option_update` after `session/new`.

**Consequence for Pi:** the model list is a **policy** (an ACL) decided by the proxy and the account, not a
static agent catalog. A curated list offers models the account or key may not use.

### 4.1 Discovery algorithm (`AcpProxyModelDiscovery` → `DirectProxyModelDiscovery` → `ModelListingClient`)

Runs per binding (apiType + baseUrl + headers), again whenever bindings change, with a 5 s timeout per listing.
`session/new` waits up to 10 s for discovery to settle.

1. **Account catalog** (only `openai` and `anthropic`): `GET base/models/user` with the binding headers.
   - `404` means unsupported, so fall through to step 2. Any other failure makes the listing fail (no models).
   - Body `{ data: [ { id, name?, description?, context_length?, architecture?: {input_modalities, output_modalities},
     pricing?: {prompt, completion, input_cache_read, input_cache_write} (per token), top_provider?: {context_length, max_completion_tokens},
     supported_parameters? } ] }`.
   - Records whose `output_modalities` lack `"text"` are dropped. Records are kept only if they match a known model.
   - Origin `Account`: **this list is authoritative**. With `_meta.jetbrains.air.selectedModels`, it is
     narrowed to those ids, in that order.
2. **Vendor listing** (fallback, or the only step for the others), `GET base + route`:
   - openai/xai/qwen `/models` → `data[].id`
   - anthropic `/v1/models?limit=1000` + header `anthropic-version: 2023-06-01`, paged by `has_more`/`last_id`
     → `data[].id`, `display_name`
   - google `/v1beta/models` → `models[].name` (strip `models/`), paged by `nextPageToken`
   - vertex `/v1beta1/publishers/google/models` → `publisherModels[].name` (last segment, without `@version`)
3. **Matching** listed ids against known models: exact name, the OpenRouter id, the JBAI id, or the same name
   with a date suffix stripped (`-20250929`, `-2025-09-29`). Unknown ids are logged and ignored. The listed
   id becomes the **wire name** sent as `model`.
4. **Result**: a listing → allowed models = matched ∩ declared (`availableModels`). Failure/timeout → that
   binding contributes no discovered list (Junie then falls back to its static gating).
5. When several bindings exist, a model id is claimed by the first binding (OpenAI first).

## 5. Other things Pi is missing, compared with the Junie wire

- `session/resume` (+ `sessionCapabilities.resume`): AIR restarts the agent on every proxy identity change
  (auth source switch, BYOK) and resumes the chat. Without it: "This agent cannot resume the saved session".
- `_auth/status_update {authStatus: {kind: "api_key", label, detail: "Proxy"}}` after binding/session events:
  this is what AIR's auth status shows. Optional.
- `loadSession`, `session/list` with real sessions: not required for resume.
