// Native Codex catalog fixture: canonical messages take precedence over legacy instructions.
// Keep both forms so the routing matrix exercises the real native metadata contract.
export const MATRIX_PROVIDER_INSTRUCTIONS =
  'Provider canonical instructions must be preserved exactly.'
export const MATRIX_LEGACY_INSTRUCTIONS =
  'Legacy instructions must not replace the canonical template.'

export function nativeMatrixCatalogModel(id, label) {
  return {
    slug: id,
    display_name: label,
    description: 'Native Codex protocol matrix profile',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({
      effort,
      description: 'Native reasoning effort: ' + effort,
    })),
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    base_instructions: MATRIX_LEGACY_INSTRUCTIONS,
    model_messages: {
      instructions_template: MATRIX_PROVIDER_INSTRUCTIONS,
    },
    include_skills_usage_instructions: false,
    supports_reasoning_summaries: true,
    supports_reasoning_summary_parameter: true,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 272000,
    max_context_window: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    supports_search_tool: true,
    use_responses_lite: true,
    tool_mode: 'code_mode_only',
    multi_agent_version: 'v1',
  }
}
