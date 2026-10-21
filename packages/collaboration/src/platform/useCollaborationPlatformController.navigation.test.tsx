// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject, CollaborationWorkspace } from '../types'
import type { CollaborationPlatformLocation } from './types'
import {
  useCollaborationPlatformController,
  type CollaborationPlatformState,
} from './useCollaborationPlatformController'

const localWorkspace = { id: 'local', project_count: 0 } as CollaborationWorkspace
const cloudWorkspace = { id: 'cloud', project_count: 1 } as CollaborationWorkspace
const project = { id: 'project', workspace_id: 'cloud' } as CollaborationProject
const location: CollaborationPlatformLocation = {
  platformView: 'spaces',
  workspaceId: 'cloud',
  workspaceView: 'home',
  projectId: project.id,
  projectView: 'board',
  issueId: null,
}
let root: Root | undefined
let container: HTMLDivElement

function currentState(): CollaborationPlatformState {
  return JSON.parse(container.textContent ?? '{}')
}

function apiFor(workspace: CollaborationWorkspace, projects: CollaborationProject[]) {
  return {
    projects: { list: vi.fn(async () => projects) },
    workspaces: { list: vi.fn(async () => [workspace]) },
  } as unknown as SharedWorkspaceApi
}

function Harness(props: {
  api: SharedWorkspaceApi
  navigationApis: SharedWorkspaceApi[]
  location: CollaborationPlatformLocation
}) {
  const { state } = useCollaborationPlatformController({
    ...props,
    loadFailedMessage: 'Failed',
  })
  return <output>{JSON.stringify(state)}</output>
}

async function render(navigationApis: SharedWorkspaceApi[], nextLocation = location) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () =>
    root!.render(
      <Harness api={navigationApis[0]} navigationApis={navigationApis} location={nextLocation} />
    )
  )
}

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
  vi.unstubAllGlobals()
})

it.each([
  { incomplete: false, projectId: null },
  { incomplete: true, projectId: null },
  { incomplete: false, projectId: project.id },
  { incomplete: true, projectId: project.id },
])(
  'loads a new navigation source with incomplete=$incomplete and project=$projectId',
  async ({ incomplete, projectId }) => {
    const nextLocation = { ...location, workspaceId: projectId ? 'cloud' : null, projectId }
    const cloudApi = apiFor(cloudWorkspace, [project])
    const unavailableLocalApi = apiFor(localWorkspace, [])
    if (incomplete) {
      vi.mocked(unavailableLocalApi.workspaces!.list).mockRejectedValueOnce(
        new Error('Unavailable')
      )
    }
    await render(incomplete ? [cloudApi, unavailableLocalApi] : [cloudApi], nextLocation)
    expect(currentState().navigationIncomplete).toBe(incomplete)

    const localApi = apiFor(localWorkspace, [])
    await render([cloudApi, localApi], nextLocation)

    expect(
      currentState()
        .workspaces.map(workspace => workspace.id)
        .sort()
    ).toEqual(['cloud', 'local'])
    expect(currentState().navigationIncomplete).toBe(false)
    expect(localApi.workspaces!.list).toHaveBeenCalledOnce()
  }
)

it('reuses the cache when the navigation source identities are unchanged', async () => {
  const cloudApi = apiFor(cloudWorkspace, [project])
  await render([cloudApi])
  await render([cloudApi])
  expect(cloudApi.projects.list).toHaveBeenCalledOnce()
  expect(cloudApi.workspaces!.list).toHaveBeenCalledOnce()
})
