// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCollaborationTranslator } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'
import { ProjectExecutionEnvironments } from './ProjectExecutionEnvironments'

const project = {
  id: 'project-a',
  project_store: 'local',
  access_role: 'Owner',
  version: 1,
  execution_environment: {
    workspace_policy: 'git_worktree',
    repositories: [],
    setup_steps: [],
  },
} as CollaborationProject
const device = {
  id: 'runner-1',
  device_id: 1,
  device_key: 'device-1',
  name: 'Runner',
  status: 'online',
  kind: 'local_device',
  coding_tools: [],
}
const translate = createCollaborationTranslator('en')
let root: Root | undefined
let container: HTMLDivElement

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}

function createApi() {
  return {
    projects: {
      get: vi.fn(async () => project),
      listExecutionEnvironments: vi.fn(async () => [device]),
      update: vi.fn(async () => project),
      initializeExecutionEnvironment: vi.fn(async () => project),
    },
    resources: { devices: { local: vi.fn(async () => []) } },
  } as unknown as SharedWorkspaceApi
}

async function render(api: SharedWorkspaceApi, selectedProject = project) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () =>
    root!.render(
      <ProjectExecutionEnvironments api={api} project={selectedProject} translate={translate} />
    )
  )
}

function element<T extends HTMLElement>(suffix: string) {
  const value = container.querySelector<T>(
    `[data-testid="collaboration-project-execution-environment${suffix}"]`
  )
  if (!value) throw new Error(`Missing ${suffix}`)
  return value
}

async function selectPolicy(value: string) {
  await act(async () => {
    const select = element<HTMLSelectElement>('-workspace-policy')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  vi.unstubAllGlobals()
})

describe('execution environment configuration snapshots', () => {
  it.each(['save', 'initialize'] as const)(
    'commits the complete %s result ahead of an older prop refresh received in flight',
    async operation => {
      const api = createApi()
      const pending = deferred<CollaborationProject>()
      const method =
        operation === 'save' ? api.projects.update : api.projects.initializeExecutionEnvironment
      vi.mocked(method).mockReturnValueOnce(pending.promise)
      await render(api)
      if (operation === 'save') await selectPolicy('project')
      await act(async () =>
        element<HTMLButtonElement>(
          operation === 'save' ? '-save-configuration' : '-initialize-1'
        ).click()
      )
      await render(api, {
        ...project,
        execution_environment: { repositories: [], setup_steps: [] },
      })
      const committed = {
        ...project,
        version: 2,
        execution_environment: {
          workspace_policy: 'project' as const,
          repositories: [
            {
              name: 'Canonical',
              url: 'https://example.test/repo.git',
              ref: 'main',
              path: 'repo',
              primary: true,
            },
          ],
          setup_steps: [{ command: 'canonical-setup', working_directory: 'repo' }],
          devices: { 'device-1': { status: 'ready' as const, error: '' } },
        },
      }
      await act(async () => pending.resolve(committed))
      expect(element<HTMLSelectElement>('-workspace-policy').value).toBe('project')
      expect(element<HTMLInputElement>('-repository-name-0').value).toBe('Canonical')
      expect(element<HTMLInputElement>('-setup-command-0').value).toBe('canonical-setup')
      expect(element('-1').dataset.preparationState).toBe('ready')
      await render(api, {
        ...project,
        execution_environment: { repositories: [], setup_steps: [] },
      })
      expect(element<HTMLSelectElement>('-workspace-policy').value).toBe('project')
      expect(element<HTMLInputElement>('-repository-name-0').value).toBe('Canonical')
      await act(async () => element<HTMLButtonElement>('-initialize-1').click())
      expect(api.projects.initializeExecutionEnvironment).toHaveBeenLastCalledWith(project.id, {
        deviceId: 1,
        version: 2,
      })
    }
  )

  it('requires an explicit rebase before saving dirty content over a newer configuration', async () => {
    const api = createApi()
    await render(api)
    await selectPolicy('project')
    const latest = {
      ...project,
      version: 3,
      execution_environment: {
        repositories: [
          {
            name: 'Server',
            url: 'https://example.test/server.git',
            ref: 'main',
            path: 'server',
            primary: true,
          },
        ],
        setup_steps: [],
      },
    } as CollaborationProject
    vi.mocked(api.projects.get).mockResolvedValue(latest)
    vi.mocked(api.projects.update).mockResolvedValue({
      ...latest,
      version: 4,
      execution_environment: {
        workspace_policy: 'project',
        repositories: [],
        setup_steps: [],
      },
    })
    await render(api, latest)
    expect(element<HTMLSelectElement>('-workspace-policy').value).toBe('project')
    expect(container.querySelector('[data-testid$="-repository-name-0"]')).toBeNull()
    await act(async () => element<HTMLButtonElement>('-save-configuration').click())
    expect(element<HTMLButtonElement>('-save-configuration').disabled).toBe(true)
    expect(api.projects.update).not.toHaveBeenCalled()
    await act(async () => element<HTMLButtonElement>('-rebase-configuration').click())
    expect(api.projects.get).toHaveBeenCalledExactlyOnceWith(project.id)
    expect(element<HTMLSelectElement>('-workspace-policy').value).toBe('project')
    expect(container.querySelector('[data-testid$="-repository-name-0"]')).toBeNull()
    await act(async () => element<HTMLButtonElement>('-save-configuration').click())
    expect(api.projects.update).toHaveBeenCalledExactlyOnceWith(project.id, {
      version: 3,
      executionEnvironment: { workspacePolicy: 'project', repositories: [], setupSteps: [] },
    })
  })

  it('does not let an earlier project initialization block or replace the next project draft', async () => {
    const api = createApi()
    const pending = deferred<CollaborationProject>()
    vi.mocked(api.projects.initializeExecutionEnvironment).mockReturnValueOnce(pending.promise)
    await render(api)
    await act(async () => element<HTMLButtonElement>('-initialize-1').click())
    const next = {
      ...project,
      id: 'project-b',
      version: 5,
      execution_environment: {
        workspace_policy: 'project' as const,
        repositories: [],
        setup_steps: [],
      },
    }
    await render(api, next)
    expect(element<HTMLSelectElement>('-workspace-policy').value).toBe('project')
    expect(element<HTMLButtonElement>('-initialize-1').disabled).toBe(false)
    await act(async () => pending.resolve({ ...project, version: 2 }))
    expect(element<HTMLSelectElement>('-workspace-policy').value).toBe('project')
    await act(async () => element<HTMLButtonElement>('-initialize-1').click())
    expect(api.projects.initializeExecutionEnvironment).toHaveBeenLastCalledWith(next.id, {
      deviceId: 1,
      version: 5,
    })
  })
})
