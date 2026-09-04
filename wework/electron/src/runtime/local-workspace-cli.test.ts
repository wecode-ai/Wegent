import { describe, expect, test } from 'vitest'
import { parseLocalWorkspaceOpenRequest } from './local-workspace-cli.js'

describe('parseLocalWorkspaceOpenRequest', () => {
  test('parses and resolves a workspace request', () => {
    expect(
      parseLocalWorkspaceOpenRequest(
        ['electron', 'app', '--open-workspace', './project', '--workspace-label', 'Demo'],
        '/workspace'
      )
    ).toEqual({
      path: '/workspace/project',
      label: 'Demo',
    })
  })

  test('ignores invocations without a usable workspace path', () => {
    expect(parseLocalWorkspaceOpenRequest(['electron', 'app'])).toBeNull()
    expect(parseLocalWorkspaceOpenRequest(['electron', 'app', '--open-workspace', ' '])).toBeNull()
  })
})
