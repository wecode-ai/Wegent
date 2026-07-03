import { describe, expect, test } from 'vitest'
import { buildRuntimeTaskRoute, parseRuntimeTaskRoute } from './navigation'

describe('runtime task navigation', () => {
  test('builds runtime task routes without exposing workspace paths', () => {
    const route = buildRuntimeTaskRoute({
      deviceId: 'axb-mac.local',
      workspacePath: '/Users/axb-mac/work/Wegent github',
      taskId: 12345,
    })

    expect(route).toBe('/runtime-tasks?deviceId=axb-mac.local&taskId=12345')
    expect(route).not.toContain('workspacePath')
    expect(route).not.toContain('%2FUsers%2Faxb-mac%2Fwork%2FWegent')
  })

  test('parses runtime task routes from device and task ids only', () => {
    expect(
      parseRuntimeTaskRoute(
        '/runtime-tasks',
        '?deviceId=axb-mac.local&taskId=12345'
      )
    ).toEqual({
      deviceId: 'axb-mac.local',
      taskId: 12345,
    })
  })
})
