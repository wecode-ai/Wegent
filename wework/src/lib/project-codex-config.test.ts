import { describe, expect, test } from 'vitest'
import { enabledProjectPluginKeys, setProjectPluginEnabled } from './project-codex-config'

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
})
