import { describe, expect, test } from 'vitest'
import { buildTrayUsageTitle } from './trayUsageTitle'

describe('buildTrayUsageTitle', () => {
  test('keeps both Codex windows when only Codex is visible', () => {
    expect(
      buildTrayUsageTitle({
        codex: '5h 90%\n7d 80%',
        compactCodex: 'Codex  80%',
        wegent: null,
      })
    ).toBe('5h 90%\n7d 80%')
  })

  test('shows the short quota source when only cloud quota is visible', () => {
    expect(buildTrayUsageTitle({ codex: null, compactCodex: null, wegent: 'AIGC -84.7' })).toBe(
      'AIGC -84.7'
    )
  })

  test('uses two compact lines when both quotas are visible', () => {
    expect(
      buildTrayUsageTitle({
        codex: '5h 90%\n7d 80%',
        compactCodex: 'Codex  80%',
        wegent: 'AIGC -84.7',
      })
    ).toBe('Codex  80%\nAIGC -84.7')
  })
})
