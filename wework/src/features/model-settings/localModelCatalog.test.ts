// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  createDefaultLocalModelCatalogEntry,
  normalizeLocalModelCatalogEntry,
} from './localModelCatalog'

describe('localModelCatalog', () => {
  it('uses a complete Codex-shaped default capability profile', () => {
    const entry = createDefaultLocalModelCatalogEntry({
      id: 'My Model',
      displayName: 'My Model',
      toolProfile: 'custom',
    })

    expect(entry).toMatchObject({
      slug: 'wework-custom-my-model',
      display_name: 'My Model',
      shell_type: 'shell_command',
      apply_patch_tool_type: 'freeform',
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      supports_parallel_tool_calls: false,
      context_window: 272_000,
      max_context_window: 272_000,
      effective_context_window_percent: 95,
      input_modalities: ['text'],
      supports_reasoning_summaries: true,
      supports_reasoning_summary_parameter: true,
      supports_search_tool: true,
    })
    expect(Object.keys(entry).length).toBeGreaterThanOrEqual(30)
    expect(entry).not.toHaveProperty('base_instructions')
    expect(entry).not.toHaveProperty('include_skills_usage_instructions')
    expect(entry.tool_mode).toBe('code_mode_only')
  })

  it('keeps reasoning summary capability compatible across Codex catalog versions', () => {
    const entry = normalizeLocalModelCatalogEntry(
      { supports_reasoning_summary_parameter: false },
      {
        id: 'compatibility-model',
        displayName: 'Compatibility Model',
        toolProfile: 'custom',
      }
    )

    expect(entry.supports_reasoning_summaries).toBe(false)
    expect(entry.supports_reasoning_summary_parameter).toBe(false)
  })

  it('allows every catalog field to be overridden except model identity', () => {
    const entry = normalizeLocalModelCatalogEntry(
      {
        slug: 'gpt-5.6-sol',
        display_name: 'Wrong name',
        supports_parallel_tool_calls: true,
        input_modalities: ['text', 'image'],
        custom_future_field: { enabled: true },
        base_instructions: 'User-authored instructions',
      },
      {
        id: 'custom-id',
        displayName: 'Custom ID',
        toolProfile: 'function',
        contextWindow: 1_000_000,
      }
    )

    expect(entry).toMatchObject({
      slug: 'wework-custom-custom-id',
      display_name: 'Custom ID',
      supports_parallel_tool_calls: true,
      input_modalities: ['text', 'image'],
      custom_future_field: { enabled: true },
      base_instructions: 'User-authored instructions',
    })
  })
})
