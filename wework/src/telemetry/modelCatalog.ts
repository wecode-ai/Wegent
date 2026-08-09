// Bounded enums for AI generation telemetry.
//
// `$ai_provider` is a genuinely finite set of known model providers; anything
// else collapses to 'other'.
//
// `$ai_model` is deliberately DYNAMIC: the known set is whatever the runtime
// model catalog exposes at a given moment. The bound comes from the source —
// the catalog is fed exclusively by the three model channels Wework exposes
// (official Codex models, self-configured provider profiles, and cloud models)
// — so any id that appears there is a legitimate enum value, and anything that
// does not is 'other'. There is no static model-id list to go stale.
export const KNOWN_AI_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'minimax',
  'moonshot',
  'zhipu',
  'volcengine',
  'local',
  'other',
] as const
export type KnownAiProvider = (typeof KNOWN_AI_PROVIDERS)[number]

const PROVIDER_ALIASES: Record<string, KnownAiProvider> = {
  openai: 'openai',
  'open-ai': 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  google: 'google',
  gemini: 'google',
  deepseek: 'deepseek',
  minimax: 'minimax',
  moonshot: 'moonshot',
  kimi: 'moonshot',
  zhipu: 'zhipu',
  glm: 'zhipu',
  bigmodel: 'zhipu',
  volcengine: 'volcengine',
  ark: 'volcengine',
  doubao: 'volcengine',
  local: 'local',
}

// Model ids carry the real vendor in a recognizable prefix across every model
// channel, so they are the most reliable provider signal. The configured
// provider string is free text: cloud models and user-provided profiles can
// record the API transport (e.g. kimi served over an anthropic-messages
// endpoint reports "anthropic") instead of the actual vendor, so it is only a
// last-resort fallback and may be dirty data.
const MODEL_ID_PROVIDER_PREFIXES: ReadonlyArray<readonly [string, KnownAiProvider]> = [
  ['moonshot-', 'moonshot'],
  ['kimi-', 'moonshot'],
  ['deepseek-', 'deepseek'],
  ['minimax-', 'minimax'],
  ['doubao-', 'volcengine'],
  ['glm-', 'zhipu'],
  ['claude-', 'anthropic'],
  ['gemini-', 'google'],
  ['gpt-', 'openai'],
  ['o1-', 'openai'],
  ['o3-', 'openai'],
  ['o4-', 'openai'],
]

export function toKnownAiProvider(
  modelId: string | null | undefined,
  provider: string | null | undefined,
  weworkModelKind?: unknown
): KnownAiProvider {
  const normalizedModelId = modelId?.trim().toLowerCase()
  if (normalizedModelId) {
    for (const [prefix, known] of MODEL_ID_PROVIDER_PREFIXES) {
      if (normalizedModelId.startsWith(prefix)) return known
    }
  }
  // Official Codex catalog models are routed through Wework's openai-responses
  // proxy regardless of their id prefix.
  if (weworkModelKind === 'codex-official') return 'openai'
  if (!provider) return 'other'
  const normalized = provider.trim().toLowerCase()
  return PROVIDER_ALIASES[normalized] ?? 'other'
}

export function normalizeAiModelId(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized || null
}

export function toKnownAiModelId(
  value: string | null | undefined,
  knownModelIds: ReadonlySet<string>
): string {
  const normalized = normalizeAiModelId(value)
  return normalized && knownModelIds.has(normalized) ? normalized : 'other'
}
