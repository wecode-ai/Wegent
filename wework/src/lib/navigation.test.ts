import { describe, expect, test } from 'vitest'
import { buildRuntimeTaskRoute, parseRuntimeTaskRoute } from './navigation'

describe('runtime task navigation', () => {
  test('builds runtime task routes without exposing workspace paths', () => {
    const route = buildRuntimeTaskRoute({
      deviceId: 'axb-mac.local',
      workspacePath: '/Users/axb-mac/work/Wegent github',
      localTaskId: '019ee7f6-456a-78a1-96b1-66451afc310e',
    })

    expect(route).toBe(
      '/runtime-tasks?deviceId=axb-mac.local&localTaskId=019ee7f6-456a-78a1-96b1-66451afc310e'
    )
    expect(route).not.toContain('workspacePath')
    expect(route).not.toContain('%2FUsers%2Faxb-mac%2Fwork%2FWegent')
  })

  test('parses runtime task routes from device and local task ids only', () => {
    expect(
      parseRuntimeTaskRoute(
        '/runtime-tasks',
        '?deviceId=axb-mac.local&localTaskId=019ee7f6-456a-78a1-96b1-66451afc310e'
      )
    ).toEqual({
      deviceId: 'axb-mac.local',
      localTaskId: '019ee7f6-456a-78a1-96b1-66451afc310e',
    })
  })
})
