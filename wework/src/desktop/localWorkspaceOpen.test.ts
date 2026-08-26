import { describe, expect, test, vi } from 'vitest'
import {
  installLocalWorkspaceOpenListener,
  takePendingLocalWorkspaceOpenRequests,
} from './localWorkspaceOpen'

describe('localWorkspaceOpen', () => {
  test('has no pending workspace requests in the Electron host', async () => {
    await expect(takePendingLocalWorkspaceOpenRequests()).resolves.toEqual([])
  })

  test('does not install a legacy native workspace listener', () => {
    const openWorkspace = vi.fn()

    expect(installLocalWorkspaceOpenListener(openWorkspace)).toBeNull()
    expect(openWorkspace).not.toHaveBeenCalled()
  })
})
