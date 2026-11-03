import { beforeEach, describe, expect, test } from 'vitest'
import { dshWorkspaceTabIdFromPath, dshWorkspaceTabRoute } from './dshWorkspaceTabs'

describe('dshWorkspaceTabs', () => {
  beforeEach(() => {
    delete window.__WEWORK_DSH_UI__
  })

  test('round-trips DSH workspace routes', () => {
    expect(dshWorkspaceTabRoute('plugin:dashboard')).toBe('/dsh/workspace/plugin%3Adashboard')
    expect(dshWorkspaceTabIdFromPath('/dsh/workspace/plugin%3Adashboard')).toBe('plugin:dashboard')
    expect(dshWorkspaceTabIdFromPath('/dsh/workspace/')).toBeNull()
  })
})
