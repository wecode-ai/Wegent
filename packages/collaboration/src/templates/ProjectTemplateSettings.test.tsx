// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectTemplateSettings } from './ProjectTemplateSettings'
import { CollaborationTemplateContext } from './context'
import { CollaborationTemplateStore } from './store'
import { templateMessages } from './messages'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup, CollaborationProject } from '../types'
import type { CollaborationLocale } from '../i18n'

const project = {
  id: 'project',
  project_store: 'cloud',
  name: 'Original',
  description: '',
} as CollaborationProject
const group: CollaborationGroup = {
  id: 'group',
  workspace_id: 'workspace',
  owner_type: 'project',
  owner_id: project.id,
  name: 'Group',
  description: '',
  leader: { kind: 'human', id: '7', responsibility: '' },
  members: [],
  coordination_mode: 'manager',
  stages: [],
  version: 1,
  created_by_user_id: 7,
  created_at: '',
  updated_at: '',
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  return {
    projects: {
      get: vi.fn(async (id: string) => ({ ...project, id, name: `Loaded ${id}` })),
      listCollaborationGroups: vi.fn(async () => [group]),
    },
    automations: { list: vi.fn(async () => []) },
    agents: { list: vi.fn(async () => []) },
  }
}
let root: Root
let container: HTMLDivElement
let store: CollaborationTemplateStore
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  store = new CollaborationTemplateStore({
    scope: 'local:settings-test',
    ownerId: 7,
    persistence: { read: async () => [], write: async () => {} },
  })
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  vi.restoreAllMocks()
})
async function render(
  api: ReturnType<typeof fixture>,
  current = project,
  locale: CollaborationLocale = 'en'
) {
  await act(async () =>
    root.render(
      <CollaborationTemplateContext value={store}>
        <ProjectTemplateSettings
          api={api as unknown as SharedWorkspaceApi}
          project={current}
          locale={locale}
          canManage
        />
      </CollaborationTemplateContext>
    )
  )
}
function button(id: string) {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!
}

it('uses the loaded configuration for saving and changes locale without refetching', async () => {
  const api = fixture()
  await render(api)
  await render(api, project, 'zh-CN')
  expect(api.projects.get).toHaveBeenCalledTimes(1)
  expect(api.automations.list).toHaveBeenCalledTimes(1)
  await act(async () => button('project-template-save').click())
  expect(
    container.querySelector<HTMLInputElement>('[data-testid="template-save-name"]')?.value
  ).toBe('Loaded project')
  await render(api, { ...project, id: 'next-project' })
  expect(container.querySelector('[data-testid="template-save-name"]')).toBeNull()
  expect(button('project-template-save').disabled).toBe(false)
})

it('localizes load failures without another request and supports an explicit retry', async () => {
  const api = fixture()
  api.projects.get.mockRejectedValueOnce(new Error('offline'))
  await render(api)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    templateMessages.en.failed
  )
  await render(api, project, 'zh-CN')
  expect(api.projects.get).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    templateMessages['zh-CN'].failed
  )
  await act(async () => button('project-template-retry').click())
  expect(api.projects.get).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(button('project-template-save').disabled).toBe(false)
})

it('ignores a pending snapshot after changing the API owner for the same project', async () => {
  const first = fixture()
  const pending = deferred<[]>()
  first.agents.list.mockReturnValueOnce(pending.promise)
  await render(first)
  await act(async () => button('project-template-save').click())
  expect(button('project-template-save').disabled).toBe(true)
  const second = fixture()
  await render(second)
  expect(button('project-template-save').disabled).toBe(false)
  await act(async () => pending.resolve([]))
  expect(container.querySelector('[data-testid="template-save-name"]')).toBeNull()
  expect(container.querySelector('[role="alert"]')).toBeNull()
})
