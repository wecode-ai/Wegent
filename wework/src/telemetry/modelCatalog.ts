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

export function toKnownAiProvider(value: string | null | undefined): KnownAiProvider {
  if (!value) return 'other'
  const normalized = value.trim().toLowerCase()
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
