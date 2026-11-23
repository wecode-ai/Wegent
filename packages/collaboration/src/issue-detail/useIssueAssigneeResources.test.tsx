// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { CollaborationOwnedAgent, CollaborationProject } from '../types'
import type { SharedIssueDetailPort } from './createSharedIssueDetailPort'
import { useIssueAssigneeResources } from './useIssueAssigneeResources'

it('keys catalogs by project permissions and assignment and rejects detached errors and results', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.createElement('div'))
  let agents!: CollaborationOwnedAgent[]
  const onError = vi.fn()
  let resolveOld!: (agents: CollaborationOwnedAgent[]) => void
  let rejectOld!: (error: Error) => void
  const list = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve
        })
    )
    .mockResolvedValueOnce([{ id: 'current' }])
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject
        })
    )
    .mockResolvedValueOnce([{ id: 'assigned' }])
    .mockRejectedValueOnce(new Error('current error'))
  const port = { agentResources: { list } } as unknown as SharedIssueDetailPort
  const project = {
    id: 'one',
    project_store: 'local',
    access_role: 'maintainer',
  } as CollaborationProject
  function Harness({
    value = project,
    assigned,
  }: {
    value?: CollaborationProject
    assigned?: string
  }) {
    agents = useIssueAssigneeResources(port, value, onError, assigned)
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => root.render(<Harness value={{ ...project, id: 'two' }} />))
    expect(agents[0].id).toBe('current')
    await act(async () => resolveOld([{ id: 'stale' }] as CollaborationOwnedAgent[]))
    expect(agents[0].id).toBe('current')
    await act(async () => root.render(<Harness value={{ ...project, access_role: 'viewer' }} />))
    expect(agents).toEqual([])
    await act(async () =>
      root.render(<Harness value={{ ...project, access_role: 'viewer' }} assigned="agent" />)
    )
    expect(agents[0].id).toBe('assigned')
    await act(async () => rejectOld(new Error('detached error')))
    expect(onError).not.toHaveBeenCalled()
    await act(async () => root.render(<Harness assigned="other" />))
    expect(onError).toHaveBeenCalledExactlyOnceWith('current error')
    expect(agents).toEqual([])
  } finally {
    await act(async () => root.unmount())
  }
})
