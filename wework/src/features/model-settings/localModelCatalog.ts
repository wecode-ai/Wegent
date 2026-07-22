import type { LocalModelToolProfile } from './localModelSettings'
import GPT_DEFAULT_INSTRUCTIONS from './gptDefaultInstructions.md?raw'

export type LocalModelCatalogEntry = Record<string, unknown>

export const DEFAULT_CUSTOM_MODEL_BASE_INSTRUCTIONS = GPT_DEFAULT_INSTRUCTIONS.replace(
  'You are Codex, an agent based on GPT-5.',
  'You are Codex, a coding agent.'
)

function catalogSlug(id: string): string {
  const normalized = id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `wework-custom-${normalized || 'model'}`
}

export function createDefaultLocalModelCatalogEntry(input: {
  id: string
  displayName: string
  toolProfile: LocalModelToolProfile
  contextWindow?: number
}): LocalModelCatalogEntry {
  const contextWindow = input.contextWindow ?? 272_000
  return {
    slug: catalogSlug(input.id),
    display_name: input.displayName || 'Custom model',
    description: 'User-configured Codex model capability profile',
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'shell_command',
    visibility: 'none',
    supported_in_api: true,
    priority: 10_000,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: DEFAULT_CUSTOM_MODEL_BASE_INSTRUCTIONS,
    model_messages: null,
    include_skills_usage_instructions: false,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: input.toolProfile === 'shell' ? null : 'freeform',
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: null,
    tool_mode: null,
    multi_agent_version: null,
  }
}

export function normalizeLocalModelCatalogEntry(
  value: unknown,
  input: {
    id: string
    displayName: string
    toolProfile: LocalModelToolProfile
    contextWindow?: number
  }
): LocalModelCatalogEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Catalog entry must be a JSON object')
  }
  const entry = value as LocalModelCatalogEntry
  const defaults = createDefaultLocalModelCatalogEntry(input)
  return {
    ...defaults,
    ...entry,
    slug: defaults.slug,
    display_name: input.displayName || defaults.display_name,
  }
}
