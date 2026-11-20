import { sdkSelectValue } from '../test/selectControl'
// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'
import { ProjectExecutionEnvironments } from './ProjectExecutionEnvironments'

const project = {
  id: 'recovery-project',
  version: 1,
  access_role: 'Maintainer',
  project_store: 'local',
} as CollaborationProject
const latest = {
  ...project,
  version: 3,
  execution_environment: {
    repositories: [],
    setup_steps: [{ command: 'echo server', working_directory: '' }],
    fingerprint: 'server',
    devices: {},
    workspace_policy: 'project',
  },
} as CollaborationProject
const prefix = 'collaboration-project-execution-environment'
let container: HTMLDivElement
let root: Root
const element = <T extends HTMLElement = HTMLElement>(suffix: string) =>
  container.querySelector<T>(`[data-testid="${prefix}${suffix}"]`)!
const click = async (suffix: string) => act(async () => element(suffix).click())

async function setup(saveConflict = true) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const update = vi.fn(async () => latest).mockRejectedValueOnce(new Error('Cloud project changed'))
  const get = vi.fn(async () => latest)
  const api = {
    projects: { get, update, listExecutionEnvironments: vi.fn(async () => []) },
  } as unknown as SharedWorkspaceApi
  const onProjectChange = vi.fn()
  await act(async () =>
    root.render(
      <ProjectExecutionEnvironments
        api={api}
        project={project}
        onProjectChange={onProjectChange}
        translate={createCollaborationTranslator('zh-CN')}
      />
    )
  )
  await click('-preparation-toggle')
  await click('-add-setup-step')
  const input = element<HTMLInputElement>('-setup-command-0')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'echo draft'
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (saveConflict) {
    await click('-save-configuration')
    expect(element('-configuration-error').textContent).toContain('草稿尚未保存')
    expect(element<HTMLButtonElement>('-save-configuration').disabled).toBe(true)
    expect(input.value).toBe('echo draft')
    expect(onProjectChange).not.toHaveBeenCalled()
  }
  return { update, get, onProjectChange, api }
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
})

it('refreshes clean saved setup fields when another settings page updates the project', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const api = {
    projects: { listExecutionEnvironments: vi.fn(async () => []) },
  } as unknown as SharedWorkspaceApi
  const render = (selected: CollaborationProject) =>
    act(async () =>
      root.render(
        <ProjectExecutionEnvironments
          api={api}
          project={selected}
          translate={createCollaborationTranslator('zh-CN')}
        />
      )
    )
  await render({
    ...latest,
    version: 1,
    execution_environment: {
      ...latest.execution_environment!,
      setup_steps: [{ command: 'echo old', working_directory: '' }],
    },
  })
  await render(latest)
  expect(element<HTMLInputElement>('-setup-command-0').value).toBe('echo server')
})

it('rebases a preserved draft through a read and requires another explicit versioned save', async () => {
  const { update, get, onProjectChange } = await setup()
  await click('-rebase-configuration')
  expect(get).toHaveBeenCalledExactlyOnceWith(project.id)
  expect(update).toHaveBeenCalledTimes(1)
  expect(onProjectChange).toHaveBeenCalledExactlyOnceWith(latest)
  expect(element<HTMLInputElement>('-setup-command-0').value).toBe('echo draft')
  expect(element('-configuration-notice').textContent).toContain('草稿尚未保存')
  expect(element<HTMLButtonElement>('-save-configuration').disabled).toBe(false)
  await click('-save-configuration')
  expect(element('-configuration-notice')).toBeNull()
  expect(update).toHaveBeenLastCalledWith(project.id, {
    version: 3,
    executionEnvironment: {
      workspacePolicy: 'git_worktree',
      repositories: [],
      setupSteps: [{ command: 'echo draft', workingDirectory: '' }],
    },
  })
  expect(update).toHaveBeenCalledTimes(2)
})

it('preserves the draft after a failed read and retries only that read before loading server values', async () => {
  const { update, get } = await setup()
  get.mockRejectedValueOnce(new Error('offline'))
  await click('-reload-configuration')
  expect(element('-configuration-error').textContent).toContain('草稿已保留')
  expect(element<HTMLInputElement>('-setup-command-0').value).toBe('echo draft')
  expect(update).toHaveBeenCalledTimes(1)
  await click('-reload-configuration')
  expect(get).toHaveBeenCalledTimes(2)
  expect(update).toHaveBeenCalledTimes(1)
  expect(element<HTMLInputElement>('-setup-command-0').value).toBe('echo server')
  expect(await sdkSelectValue(element('-workspace-policy'))).toBe('project')
  expect(element('-configuration-error')).toBeNull()
  expect(element<HTMLButtonElement>('-save-configuration').disabled).toBe(true)
})

it('requires an explicit choice when saved environment fields change underneath a draft', async () => {
  const { api, update, get } = await setup(false)
  await act(async () =>
    root.render(
      <ProjectExecutionEnvironments
        api={api}
        project={latest}
        translate={createCollaborationTranslator('zh-CN')}
      />
    )
  )
  expect(element<HTMLInputElement>('-setup-command-0').value).toBe('echo draft')
  expect(element('-configuration-error').textContent).toContain('草稿尚未保存')
  expect(element<HTMLButtonElement>('-save-configuration').disabled).toBe(true)
  expect(update).not.toHaveBeenCalled()
  expect(get).not.toHaveBeenCalled()
  await click('-reload-configuration')
  expect(element<HTMLInputElement>('-setup-command-0').value).toBe('echo server')
  expect(update).not.toHaveBeenCalled()
})
