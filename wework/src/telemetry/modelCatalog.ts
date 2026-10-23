// Model reporting for AI generation telemetry.
//
// `$ai_model` carries the model name from the app's model catalog, which is the
// value the user picked and what the app itself calls the model. Names are free
// text (cloud models are labelled like `ali-deepseek-v3.1(国内)`), so the only
// bound is a single-line string of a fixed maximum length.
//
// `$ai_provider` is a genuinely finite set of known model providers; anything
// else collapses to 'other'.
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

const MAX_MODEL_NAME_LENGTH = 128
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/gu

export function toTelemetryModelName(value: string | null | undefined): string {
  const normalized = value
    ?.replace(CONTROL_CHARACTER_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MODEL_NAME_LENGTH)
  return normalized ? normalized : 'other'
}
