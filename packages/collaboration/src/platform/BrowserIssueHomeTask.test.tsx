// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { SharedWorkspaceApi, SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue, CollaborationProject } from '../types'
import { BrowserIssueHomeTask, type BrowserIssueHomeTaskDraft } from './BrowserIssueHomeTask'

vi.mock('../issue-detail/useBrowserCommentExecution', () => ({
  useBrowserCommentExecution: () => ({
    target: { deviceId: 'runner', runtime: 'codex' },
    catalogCurrent: true,
    modelsReady: true,
    models: [{ name: 'test-model', displayName: 'Test model', provider: 'cloud', type: 'user' }],
    projects: [],
  }),
}))
vi.mock('../media-query', () => ({ useMediaQuery: () => false }))

it('reuses the recorded issue on launch retry and opens its accepted bound task', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.createElement('div'))
  const project = {
    id: 'project',
    project_store: 'backend',
    current_user_id: 7,
  } as CollaborationProject
  let issue = {
    id: 'issue',
    cloud_project_id: project.id,
    title: 'Review handoff',
    description: 'Review handoff',
    status: 'pending',
    version: 1,
  } as CollaborationIssue
  const create = vi.fn(async () => issue)
  const update = vi.fn(async (_id: string, input: Partial<CollaborationIssue>) => {
    issue = { ...issue, ...input, version: issue.version + 1 }
    return issue
  })
  const bindTask = vi.fn(async () => undefined)
  const unbindTask = vi.fn(async () => undefined)
  const createRuntimeTask = vi
    .fn()
    .mockResolvedValueOnce({ accepted: false, error: 'Device is offline' })
    .mockImplementationOnce(async request => ({
      accepted: true,
      deviceId: request.deviceId,
      taskId: request.taskId,
      runtime: 'codex',
    }))
  const api = {
    issues: { create, update, get: async () => issue },
    taskBindings: { bindTask, unbindTask },
  } as unknown as SharedWorkspaceApi
  const runtime = { work: { createRuntimeTask } } as unknown as SharedWorkspaceRuntimeApi
  const drafts = new Map<string, BrowserIssueHomeTaskDraft>()
  const onCreated = vi.fn()
  let submit: ((text: string, files: File[]) => Promise<boolean>) | undefined
  try {
    await act(async () =>
      root.render(
        <BrowserIssueHomeTask
          api={api}
          runtime={runtime}
          project={project}
          drafts={drafts}
          translate={createCollaborationTranslator('en')}
          translateStatus={key => key}
          onCreated={onCreated}
          onPendingChange={() => {}}
          render={controls => {
            submit = controls.submit
            return null
          }}
        />
      )
    )
    await act(async () => {
      expect(await submit?.('Review handoff', [])).toBe(false)
    })
    expect(issue.status).toBe('pending')
    expect(unbindTask).toHaveBeenCalledOnce()
    expect(onCreated).not.toHaveBeenCalled()
    await act(async () => {
      expect(await submit?.('Review handoff', [])).toBe(true)
    })
    expect(create).toHaveBeenCalledOnce()
    expect(issue.status).toBe('in_progress')
    const acceptedTaskId = createRuntimeTask.mock.calls[1][0].taskId
    expect(bindTask).toHaveBeenLastCalledWith(
      'issue',
      expect.objectContaining({ taskId: acceptedTaskId }),
      'Review handoff'
    )
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'issue' }),
      expect.objectContaining({ taskId: acceptedTaskId })
    )
    expect(drafts.size).toBe(0)
  } finally {
    await act(async () => root.unmount())
  }
})
