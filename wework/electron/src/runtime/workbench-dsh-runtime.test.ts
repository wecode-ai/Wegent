import { describe, expect, test } from 'vitest'
import { injectModelProviderPatch } from './workbench-dsh-runtime.js'

describe('workbench DSH runtime', () => {
  test('replaces an empty YAML patch list when injecting the selected model', () => {
    expect(injectModelProviderPatch('[]\n')).toBe(
      [
        '- id: agent-default-model',
        '  config:',
        '    provider: wework-local',
        '    model: wework-selected',
        '',
      ].join('\n')
    )
  })

  test('updates an existing provider and model pair', () => {
    expect(
      injectModelProviderPatch(
        [
          '- id: agent-default-model',
          '  config:',
          '    provider: fixture',
          '    model: fixture-model',
          '',
        ].join('\n')
      )
    ).toBe(
      [
        '- id: agent-default-model',
        '  config:',
        '    provider: wework-local',
        '    model: wework-selected',
        '',
      ].join('\n')
    )
  })

  test('rejects an incomplete provider and model pair', () => {
    expect(() =>
      injectModelProviderPatch('- id: agent-default-model\n  config:\n    provider: fixture\n')
    ).toThrow('Smart app exposes an incomplete provider/model pair')
  })
})
