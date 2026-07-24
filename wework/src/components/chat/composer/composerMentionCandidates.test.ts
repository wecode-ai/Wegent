import { describe, expect, test } from 'vitest'
import { appReference } from './composerMentionCandidates'

describe('appReference', () => {
  test('uses a generated Skill reference for Wegent connector apps', () => {
    expect(
      appReference({
        id: 'wegent:docs',
        name: 'Internal Docs',
        source: 'wegent-connector',
        skillPath: '/tmp/codex/skills/wegent-connector-docs/SKILL.md',
      })
    ).toBe('[$Internal Docs](/tmp/codex/skills/wegent-connector-docs/SKILL.md)')
  })

  test('preserves native Codex app references', () => {
    expect(appReference({ id: 'calendar', name: 'Calendar' })).toBe('[$Calendar](app://calendar)')
  })
})
