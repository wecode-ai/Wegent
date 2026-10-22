// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collaborationWorkspaceControllerReducer,
  createCollaborationWorkspaceControllerCommands,
  initialCollaborationWorkspaceControllerState,
  type CollaborationProject,
  type CollaborationWorkspaceControllerState,
} from '@wegent/collaboration'
import { createDeliveryApi, type CloudLoopItem, type ProjectBoardSnapshot } from '@/api/deliveries'
import { createHttpClient } from '@/api/http'
import { createProjectAutomationApi } from '@/api/projectAutomations'
import { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import { createRuntimeProfileApi } from '@/api/runtimeProfiles'
import { createWeworkSharedWorkspaceApi } from './weworkSharedWorkspaceApi'

const project: CollaborationProject = {
  id: 'project-1',
  public_id: 'public-1',
  project_key: 'PRJ',
  name: 'Project',
  description: '',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z',
}

const unassignedIssue: CloudLoopItem = {
  id: 'issue-1',
  cloud_project_id: project.id,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  human_work: null,
  title: 'Review the report',
  description: '',
  status: 'completed',
  priority: 'none',
  due_at: null,
  tags: [],
  sort_order: 0,
  current_delivery_id: null,
  version: 8,
  created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z',
  completed_at: '2026-10-16T00:00:00Z',
}

const reassignedIssue: CloudLoopItem = {
  ...unassignedIssue,
  version: 9,
  assignee_user_id: 1,
  human_work: {
    assignment_id: 'assignment-2',
    assignee_user_id: 1,
    reviewer_user_id: null,
    submission_message_id: null,
    submitted_by_user_id: null,
    state: 'none',
    result: '',
    return_reason: '',
    ai_draft_delivery_id: null,
    can_start: true,
    can_submit: false,
    can_review: false,
  },
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function snapshotResponse(issue: CloudLoopItem): Response {
  const snapshot: ProjectBoardSnapshot = {
    items: [issue],
    members: [],
    agents: [],
    task_bindings: [],
  }
  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createController(...responses: ReturnType<typeof deferredResponse>[]) {
  const fetchMock = vi.fn(() => {
    const response = responses.shift()
    if (!response) throw new Error('Unexpected HTTP request')
    return response.promise
  })
  vi.stubGlobal('fetch', fetchMock)
  const client = createHttpClient({ baseUrl: 'http://backend/api', getToken: () => null })
  const api = createWeworkSharedWorkspaceApi({
    client,
    deliveryApi: createDeliveryApi(client),
    projectAutomationApi: createProjectAutomationApi(client),
    projectIncomingHookApi: createProjectIncomingHookApi(client),
    runtimeProfileApi: createRuntimeProfileApi(client),
  })
  let state: CollaborationWorkspaceControllerState = {
    ...initialCollaborationWorkspaceControllerState,
    projects: [project],
    project,
    issues: [unassignedIssue],
    selectedIssue: unassignedIssue,
    loading: false,
  }
  const notify = vi.fn()
  const commands = createCollaborationWorkspaceControllerCommands({
    api,
    messages: { loadFailed: 'Load failed', saveFailed: 'Save failed', conflict: 'Conflict' },
    myWorkEnabled: false,
    preloadHomeSnapshots: false,
    notify,
    dispatch: action => {
      state = collaborationWorkspaceControllerReducer(state, action)
    },
    getProjects: () => state.projects,
    getSelectedIssue: () => state.selectedIssue,
    getProjectSnapshot: projectId => {
      const items = state.projectItems[projectId]
      const members = state.projectMembers[projectId]
      const agents = state.projectAgents[projectId]
      const taskBindings = state.projectTaskBindings[projectId]
      return items && members && agents && taskBindings
        ? { items, members, agents, taskBindings }
        : null
    },
    getExternalBoardState: () => state,
    getExternalBoardOptions: () => ({ parentId: null, pageSize: 100, eager: true }),
  })
  return { commands, fetchMock, notify, getState: () => state }
}

function expectReassignedState(state: CollaborationWorkspaceControllerState) {
  expect(state.selectedIssue).toEqual(reassignedIssue)
  expect(state.selectedIssue?.human_work?.can_start).toBe(true)
  expect(state.issues).toEqual([reassignedIssue])
  expect(state.projectItems[project.id]).toEqual([reassignedIssue])
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('project snapshot refresh through the Wework HTTP adapter', () => {
  it.each(['old first', 'new first'] as const)(
    'fetches reassignment independently of a pending unassignment snapshot (%s)',
    async order => {
      const oldResponse = deferredResponse()
      const newResponse = deferredResponse()
      const { commands, fetchMock, getState } = createController(oldResponse, newResponse)

      const afterUnassign = commands.loadProjectSnapshot(project.id, { invalidate: true })
      const afterReassign = commands.loadProjectSnapshot(project.id, { invalidate: true })
      try {
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(fetchMock).toHaveBeenNthCalledWith(
          2,
          'http://backend/api/v1/cloud-projects/project-1/board-snapshot',
          expect.objectContaining({ method: 'GET', cache: 'no-store' })
        )
        if (order === 'old first') {
          oldResponse.resolve(snapshotResponse(unassignedIssue))
          await expect(afterUnassign).resolves.toBeNull()
          newResponse.resolve(snapshotResponse(reassignedIssue))
          await afterReassign
        } else {
          newResponse.resolve(snapshotResponse(reassignedIssue))
          await afterReassign
          expectReassignedState(getState())
          oldResponse.resolve(snapshotResponse(unassignedIssue))
          await expect(afterUnassign).resolves.toBeNull()
        }
        expectReassignedState(getState())
      } finally {
        oldResponse.resolve(snapshotResponse(unassignedIssue))
        newResponse.resolve(snapshotResponse(reassignedIssue))
        await Promise.all([afterUnassign, afterReassign])
      }
    }
  )

  it('shares concurrent refreshes within the same mutation generation', async () => {
    const response = deferredResponse()
    const { commands, fetchMock, getState } = createController(response)

    const first = commands.loadProjectSnapshot(project.id)
    const second = commands.loadProjectSnapshot(project.id)
    try {
      expect(fetchMock).toHaveBeenCalledOnce()
      response.resolve(snapshotResponse(reassignedIssue))
      await Promise.all([first, second])
      expectReassignedState(getState())
    } finally {
      response.resolve(snapshotResponse(reassignedIssue))
      await Promise.all([first, second])
    }
  })

  it.each(['initial load', 'refresh'] as const)(
    'ignores an older %s failure after a newer snapshot succeeds',
    async source => {
      const oldResponse = deferredResponse()
      const newResponse = deferredResponse()
      const { commands, fetchMock, notify, getState } = createController(oldResponse, newResponse)

      const afterUnassign =
        source === 'initial load'
          ? commands.loadProject(project.id)
          : commands.loadProjectSnapshot(project.id)
      const afterReassign = commands.loadProjectSnapshot(project.id, { invalidate: true })
      try {
        expect(fetchMock).toHaveBeenCalledTimes(2)
        newResponse.resolve(snapshotResponse(reassignedIssue))
        await afterReassign
        oldResponse.reject(new Error('Older snapshot unavailable'))
        await afterUnassign

        expectReassignedState(getState())
        expect(getState().error).toBeNull()
        expect(getState().errorSource).toBeNull()
        expect(getState().loading).toBe(false)
        expect(notify).not.toHaveBeenCalled()
      } finally {
        oldResponse.resolve(snapshotResponse(unassignedIssue))
        newResponse.resolve(snapshotResponse(reassignedIssue))
        await Promise.all([afterUnassign, afterReassign])
      }
    }
  )

  it('retains the last snapshot after a refresh failure and recovers on the next refresh', async () => {
    const initialResponse = deferredResponse()
    const failedResponse = deferredResponse()
    const recoveryResponse = deferredResponse()
    const { commands, fetchMock, notify, getState } = createController(
      initialResponse,
      failedResponse,
      recoveryResponse
    )
    const initial = commands.loadProjectSnapshot(project.id)
    initialResponse.resolve(snapshotResponse(reassignedIssue))
    await initial

    const failed = commands.loadProjectSnapshot(project.id, { invalidate: true })
    failedResponse.reject(new Error('Snapshot unavailable'))
    await expect(failed).resolves.toBeNull()
    expectReassignedState(getState())
    expect(getState().errorSource).toBe('load')
    expect(notify).toHaveBeenCalledWith('Load failed', 'error')

    const recovery = commands.loadProjectSnapshot(project.id)
    recoveryResponse.resolve(snapshotResponse(reassignedIssue))
    await recovery

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expectReassignedState(getState())
    expect(getState().error).toBeNull()
  })
})
