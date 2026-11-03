// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'
import { CollaborationTemplateContext } from './context'
import { ProjectTemplateSettings } from './ProjectTemplateSettings'
import { CollaborationTemplateStore } from './store'

let container: HTMLDivElement
let root: Root
const project = {
  id: 'project-1',
  name: 'Delivery',
  description: '',
} as CollaborationProject

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function createApi() {
  return {
    projects: {
      get: vi.fn(async () => project),
      listCollaborationGroups: vi.fn(async () => []),
      createCollaborationGroup: vi.fn(),
    },
    automations: { list: vi.fn(async () => []) },
    members: { list: vi.fn(async () => []) },
    agents: { list: vi.fn(async () => []) },
  } as unknown as SharedWorkspaceApi
}

async function render(api: SharedWorkspaceApi, canManage = true, withStore = true) {
  const store = new CollaborationTemplateStore({
    scope: 'test:1',
    ownerId: 1,
    persistence: { read: async () => [], write: async () => undefined },
  })
  await act(async () =>
    root.render(
      <CollaborationTemplateContext.Provider value={withStore ? store : null}>
        <ProjectTemplateSettings
          api={api}
          projectId={project.id}
          locale="zh-CN"
          canManage={canManage}
        />
      </CollaborationTemplateContext.Provider>
    )
  )
}

function button(id: string) {
  const target = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
  expect(target).not.toBeNull()
  return target!
}

async function click(id: string) {
  await act(async () => button(id).click())
}

it('loads configuration only when expanded and reads a fresh snapshot when reopened', async () => {
  const api = createApi()
  await render(api)
  const toggle = button('collaboration-project-settings-sharing')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(api.projects.get).not.toHaveBeenCalled()
  expect(api.projects.listCollaborationGroups).not.toHaveBeenCalled()
  expect(api.automations!.list).not.toHaveBeenCalled()
  expect(container.querySelector('[data-testid="project-template-settings"]')).toBeNull()

  await click('collaboration-project-settings-sharing')
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.hidden).toBe(false)
  expect(api.projects.get).toHaveBeenCalledExactlyOnceWith(project.id)
  expect(api.projects.listCollaborationGroups).toHaveBeenCalledExactlyOnceWith(project.id)
  expect(button('project-template-import').disabled).toBe(false)
  expect(button('project-template-save').disabled).toBe(false)
  expect(button('project-template-export').disabled).toBe(false)
  expect(api.members.list).not.toHaveBeenCalled()
  expect(api.agents.list).not.toHaveBeenCalled()

  await click('collaboration-project-settings-sharing')
  expect(container.querySelector('[data-testid="project-template-export"]')).toBeNull()
  await click('collaboration-project-settings-sharing')
  expect(api.projects.get).toHaveBeenCalledTimes(2)
  expect(api.projects.listCollaborationGroups).toHaveBeenCalledTimes(2)
})

it('can collapse a pending read and ignores its result after reopening', async () => {
  const api = createApi()
  let reject!: (reason: Error) => void
  vi.mocked(api.projects.get).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail
      })
  )
  await render(api)
  await click('collaboration-project-settings-sharing')
  expect(button('project-template-export').disabled).toBe(true)
  await click('collaboration-project-settings-sharing')
  await click('collaboration-project-settings-sharing')
  expect(button('project-template-export').disabled).toBe(false)
  await act(async () => reject(new Error('Obsolete request')))
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(button('project-template-export').disabled).toBe(false)
})

it('keeps configuration errors local and recovers through the existing retry action', async () => {
  const api = createApi()
  vi.mocked(api.automations!.list).mockRejectedValueOnce(new Error('Unavailable'))
  await render(api)
  await click('collaboration-project-settings-sharing')
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(button('project-template-export').disabled).toBe(true)
  expect(button('collaboration-project-settings-sharing').disabled).toBe(false)
  await click('project-template-retry')
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(button('project-template-export').disabled).toBe(false)
})

it('preserves read-only export access while hiding template import', async () => {
  await render(createApi(), false)
  await click('collaboration-project-settings-sharing')
  expect(container.querySelector('[data-testid="project-template-import"]')).toBeNull()
  expect(button('project-template-save').disabled).toBe(false)
  expect(button('project-template-export').disabled).toBe(false)
})

it('hides sharing and makes no configuration requests without a template library', async () => {
  const api = createApi()
  await render(api, true, false)
  expect(container.childElementCount).toBe(0)
  expect(api.projects.get).not.toHaveBeenCalled()
})
