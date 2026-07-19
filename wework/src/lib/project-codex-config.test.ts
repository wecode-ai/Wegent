import { describe, expect, test } from 'vitest'
import {
  enabledProjectPluginKeys,
  projectConfigStringValue,
  setProjectConfigStringValue,
  setProjectPluginEnabled,
} from './project-codex-config'

describe('project Codex config', () => {
  test('reads enabled project plugins without treating disabled plugins as enabled', () => {
    const content =
      '[plugins."sites@openai-bundled"]\nenabled = true\n\n[plugins."old@test"]\nenabled = false\n'
    expect([...enabledProjectPluginKeys(content)]).toEqual(['sites@openai-bundled'])
  })

  test('adds a plugin while preserving unrelated config', () => {
    const content = 'model_reasoning_effort = "high"\n'
    expect(setProjectPluginEnabled(content, 'sites@openai-bundled', true)).toBe(
      'model_reasoning_effort = "high"\n\n[plugins."sites@openai-bundled"]\nenabled = true\n'
    )
  })

  test('removes only the selected project plugin block', () => {
    const content =
      'model = "gpt-5"\n\n[plugins."sites@openai-bundled"]\nenabled = true\n\n[features]\nplugins = true\n'
    expect(setProjectPluginEnabled(content, 'sites@openai-bundled', false)).toBe(
      'model = "gpt-5"\n\n[features]\nplugins = true\n'
    )
  })

  test('reads and updates graphical settings while preserving comments and tables', () => {
    const content =
      '# Keep this comment\nmodel = "gpt-5"\nsandbox_mode = "read-only"\n\n[features]\nplugins = true\n'
    expect(projectConfigStringValue(content, 'sandbox_mode')).toBe('read-only')
    expect(setProjectConfigStringValue(content, 'sandbox_mode', 'workspace-write')).toBe(
      '# Keep this comment\nmodel = "gpt-5"\nsandbox_mode = "workspace-write"\n\n[features]\nplugins = true\n'
    )
  })

  test('adds a graphical setting before existing tables and removes it for inheritance', () => {
    const content = 'model = "gpt-5"\n\n[features]\nplugins = true\n'
    const updated = setProjectConfigStringValue(content, 'approval_policy', 'on-request')
    expect(updated).toBe(
      'model = "gpt-5"\napproval_policy = "on-request"\n\n[features]\nplugins = true\n'
    )
    expect(setProjectConfigStringValue(updated, 'approval_policy', null)).toBe(content)
  })
})
