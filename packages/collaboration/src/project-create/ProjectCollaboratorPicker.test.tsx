// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { builtinCollaborationTemplates } from '../templates/builtins'
import { CollaborationTemplateContext } from '../templates/context'
import { CollaborationTemplateStore } from '../templates/store'
import { CollaborationTheme } from '../theme'
import type { CollaborationProject } from '../types'
import { ProjectCollaboratorPicker } from './ProjectCollaboratorPicker'
import { ProjectCreateDialog } from './ProjectCreateDialog'
import { projectCreateLabels } from './labels'
import type { ProjectCreateResourceSetup } from './types'

let root: Root
let container: HTMLDivElement
const labels = projectCreateLabels['zh-CN']
const agent: ProjectCreateResourceSetup['agents'][number] = {
  id: 'qa-agent',
  name: 'QA Agent',
  owner_type: 'user',
  owner_id: '1',
  owner_name: 'Me',
  status: 'available',
}
const person = { id: 2, user_name: 'QA Person', email: 'qa@example.test' }
const group: ProjectCreateResourceSetup['groups'][number] = {
  id: 'qa-group',
  name: 'QA Group',
  description: 'Quality',
  workspace_id: 'workspace',
  owner_type: 'workspace',
  owner_id: 'workspace',
  leader: { kind: 'agent', id: agent.id },
  members: [],
  stages: [],
  coordination_mode: 'manager',
  version: 1,
  created_by_user_id: 1,
  created_at: '',
  updated_at: '',
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const get = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const click = async (id: string) => {
  await act(async () => {
    const control = get(id)
    if (control.matches('button:not(:disabled)')) control.focus()
    control.click()
  })
}

function deferredUsers() {
  let resolve!: (users: (typeof person)[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<(typeof person)[]>((success, failure) => {
    resolve = success
    reject = failure
  })
  return { promise, resolve, reject }
}

async function renderSearchPicker(
  searchUsers: (query: string) => Promise<(typeof person)[]>,
  locale: 'zh-CN' | 'en' = 'zh-CN'
) {
  await act(async () =>
    root.render(
      <ProjectCollaboratorPicker
        labels={projectCreateLabels[locale]}
        open
        onOpenChange={vi.fn()}
        people={[]}
        excludedIds={[1]}
        agents={[]}
        groups={[]}
        searchUsers={searchUsers}
        onSelectPerson={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectGroup={vi.fn()}
      />
    )
  )
}

it.each([
  ['zh-CN', 'results'],
  ['zh-CN', 'empty'],
  ['zh-CN', 'failure'],
  ['en', 'results'],
  ['en', 'empty'],
  ['en', 'failure'],
] as const)(
  'announces %s search completion for %s without moving focus',
  async (locale, outcome) => {
    const pending = deferredUsers()
    await renderSearchPicker(() => pending.promise, locale)
    const field = get('collaboration-project-create-people-search')
    const status = get('collaboration-project-create-people-search-status')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.getAttribute('aria-atomic')).toBe('true')
    expect(status.textContent).toBe('')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await input('QA')
      expect(status.textContent).toBe(projectCreateLabels[locale].searchingPeople)
      expect(document.querySelectorAll('[role="status"]')).toHaveLength(1)
      await act(async () => vi.advanceTimersByTimeAsync(180))
      await act(async () => {
        if (outcome === 'failure') pending.reject(new Error('Directory unavailable'))
        else pending.resolve(outcome === 'empty' ? [] : [{ ...person, id: 1 }, person, person])
      })
      expect(get('collaboration-project-create-people-search-status')).toBe(status)
      expect(document.activeElement).toBe(field)
      const copy = projectCreateLabels[locale]
      if (outcome === 'failure') {
        expect(status.textContent).toBe('')
        expect(document.querySelector('[role="alert"]')?.textContent).toBe(copy.peopleSearchFailed)
      } else {
        expect(status.textContent).toBe(
          outcome === 'empty' ? copy.noMatchingCollaborators : `${copy.availablePeople}: 1`
        )
        expect(document.querySelector('[role="alert"]')).toBeNull()
      }
    } finally {
      vi.useRealTimers()
    }
  }
)

it('announces only the current query and keeps its live region when switching categories', async () => {
  const first = deferredUsers()
  const second = deferredUsers()
  const search = vi.fn((query: string) => (query === 'first' ? first.promise : second.promise))
  await renderSearchPicker(search)
  const status = get('collaboration-project-create-people-search-status')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await input('first')
    await act(async () => vi.advanceTimersByTimeAsync(180))
    await input('second')
    await act(async () => vi.advanceTimersByTimeAsync(180))
    await act(async () => second.resolve([]))
    expect(status?.textContent).toBe(labels.noMatchingCollaborators)
    await act(async () => first.resolve([person]))
    expect(status.textContent).toBe(labels.noMatchingCollaborators)
    expect(get('collaboration-project-create-member-2')).toBeNull()
    await click('collaboration-project-create-collaborator-tab-agents')
    expect(get('collaboration-project-create-people-search-status')).toBe(status)
    expect(status.textContent).toBe('')
    await click('collaboration-project-create-collaborator-tab-members')
    expect(get('collaboration-project-create-people-search-status')).toBe(status)
    expect(status.textContent).toBe(labels.noMatchingCollaborators)
    await input('')
    expect(status.textContent).toBe('')
  } finally {
    vi.useRealTimers()
  }
})
async function input(value: string) {
  const field = get('collaboration-project-create-people-search') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it.each(['Escape', 'unmount'])(
  'keeps its real portal within the owning modal and restores focus after %s',
  async action => {
    const opener = document.createElement('button')
    opener.textContent = 'Background opener'
    document.body.append(opener)
    opener.focus()
    const onClose = vi.fn()
    try {
      await act(async () =>
        root.render(
          <CollaborationTheme mode="dark">
            <ProjectCreateDialog
              targets={[{ location: 'cloud', create: vi.fn() }]}
              defaultLocation="cloud"
              labels={labels}
              allowDingTalkAITable={false}
              onClose={onClose}
              onCreated={vi.fn()}
              resourceSetup={{
                location: 'cloud',
                currentUser: { id: 1, name: 'Me' },
                members: [{ id: 2, user_id: 2, user_name: person.user_name, role: 'Developer' }],
                agents: [],
                groups: [],
                configure: vi.fn(),
              }}
            />
          </CollaborationTheme>
        )
      )
      const dialog = get('collaboration-project-create-dialog')
      const trigger = get('collaboration-project-create-add-collaborator')
      await click('collaboration-project-create-add-collaborator')
      const menu = get('collaboration-project-create-collaborator-menu')
      expect(menu.closest('[role="dialog"][aria-modal="true"]')).toBe(dialog)
      expect(menu.closest('.collaboration-project-create-body')).toBeNull()
      expect(menu.getAttribute('data-slot')).toBe('popover-content')
      expect(menu.getAttribute('popover')).toBe('manual')
      expect(menu.dataset.theme).toBe('dark')
      expect(dialog.contains(document.activeElement)).toBe(true)
      expect(document.activeElement).toBe(get('collaboration-project-create-people-search'))
      expect(get('collaboration-project-create-member-2')).toBeTruthy()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await act(async () => {
        if (action === 'Escape')
          document.activeElement!.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              keyCode: 27,
              bubbles: true,
              cancelable: true,
            })
          )
        else root.render(null)
      })
      await act(async () => vi.runAllTimersAsync())
      expect(get('collaboration-project-create-collaborator-menu')).toBeNull()
      expect(menu.isConnected).toBe(false)
      expect(document.activeElement).toBe(action === 'Escape' ? trigger : opener)
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      opener.remove()
    }
  }
)

it('does not restore a closing picker into the hidden project form after opening configuration', async () => {
  function Harness() {
    const [open, setOpen] = useState(true)
    const [configuring, setConfiguring] = useState(false)
    return (
      <section role="dialog" aria-modal="true" aria-label="Create project">
        <form hidden={configuring}>
          <ProjectCollaboratorPicker
            labels={labels}
            open={open}
            onOpenChange={setOpen}
            people={[]}
            excludedIds={[]}
            agents={[]}
            groups={[]}
            onSelectPerson={vi.fn()}
            onSelectAgent={vi.fn()}
            onSelectGroup={vi.fn()}
            groupAction={
              <button
                type="button"
                data-testid="configure-group"
                onClick={() => {
                  setOpen(false)
                  setConfiguring(true)
                }}
              >
                Configure group
              </button>
            }
          />
        </form>
        {configuring && <input autoFocus data-testid="configuration-input" />}
      </section>
    )
  }
  await act(async () => root.render(<Harness />))
  const modal = container.querySelector('[role="dialog"][aria-modal="true"]')!
  const menu = get('collaboration-project-create-collaborator-menu')
  expect(menu.closest('[role="dialog"][aria-modal="true"]')).toBe(modal)
  expect(menu.closest('form')).toBeNull()
  await click('collaboration-project-create-collaborator-tab-groups')
  const trigger = get('collaboration-project-create-add-collaborator')
  const restoreTriggerFocus = vi.spyOn(trigger, 'focus')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await click('configure-group')
    const configuration = get('configuration-input')
    expect(trigger.closest('form')?.hidden).toBe(true)
    expect(document.activeElement).toBe(configuration)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await act(async () => vi.runAllTimersAsync())
    expect(menu.isConnected).toBe(false)
    expect(restoreTriggerFocus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(configuration)
  } finally {
    vi.useRealTimers()
    restoreTriggerFocus.mockRestore()
  }
})

it('uses one search query across people, Agents and groups with keyboard navigation', async () => {
  const selectPerson = vi.fn(),
    selectAgent = vi.fn(),
    selectGroup = vi.fn()
  await act(async () =>
    root.render(
      <ProjectCollaboratorPicker
        labels={labels}
        open
        onOpenChange={vi.fn()}
        people={[person]}
        excludedIds={[]}
        agents={[agent]}
        groups={[group]}
        onSelectPerson={selectPerson}
        onSelectAgent={selectAgent}
        onSelectGroup={selectGroup}
      />
    )
  )
  expect([...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual([
    '人员',
    '智能体',
    '小组',
  ])
  await input('missing')
  expect(get('collaboration-project-create-member-2')).toBeNull()
  await input('QA')
  await click('collaboration-project-create-member-2')
  await click('collaboration-project-create-collaborator-tab-agents')
  await click('collaboration-project-create-agent-qa-agent')
  await click('collaboration-project-create-collaborator-tab-groups')
  await click('collaboration-project-create-group-qa-group')
  const tab = get('collaboration-project-create-collaborator-tab-groups')
  await act(async () =>
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  )
  expect(
    get('collaboration-project-create-collaborator-tab-members').getAttribute('aria-selected')
  ).toBe('true')
  expect(
    document.querySelectorAll('[data-testid="collaboration-project-create-people-search"]')
  ).toHaveLength(1)
  expect((get('collaboration-project-create-people-search') as HTMLInputElement).value).toBe('QA')
  expect(selectPerson).toHaveBeenCalledWith(person)
  expect(selectAgent).toHaveBeenCalledWith(agent.id)
  expect(selectGroup).toHaveBeenCalledWith(group.id)
})

it('explains empty categories separately from a search with no matches', async () => {
  await act(async () =>
    root.render(
      <ProjectCollaboratorPicker
        labels={labels}
        open
        onOpenChange={vi.fn()}
        people={[]}
        excludedIds={[]}
        agents={[]}
        groups={[]}
        onSelectPerson={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectGroup={vi.fn()}
      />
    )
  )
  const menu = () => get('collaboration-project-create-collaborator-menu').textContent
  expect(get('collaboration-project-create-collaborator-menu').getAttribute('aria-label')).toBe(
    labels.addCollaborator
  )
  expect(menu()).toContain(labels.noAvailablePeople)
  expect(menu()).toContain(labels.collaboratorsOptionalHint)
  await click('collaboration-project-create-collaborator-tab-agents')
  expect(menu()).toContain(labels.noAvailableAgents)
  await click('collaboration-project-create-collaborator-tab-groups')
  expect(menu()).toContain(labels.noAvailableGroups)
  await input('missing')
  expect(menu()).toContain(labels.noMatchingCollaborators)
  expect(menu()).not.toContain(labels.noAvailableGroups)
})

it('offers a directory search when no other space members are listed', async () => {
  const searchUsers = vi.fn()
  await act(async () =>
    root.render(
      <ProjectCollaboratorPicker
        labels={labels}
        open
        onOpenChange={vi.fn()}
        people={[]}
        excludedIds={[]}
        agents={[]}
        groups={[]}
        searchUsers={searchUsers}
        onSelectPerson={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectGroup={vi.fn()}
      />
    )
  )
  expect(get('collaboration-project-create-collaborator-menu').textContent).toContain(
    labels.searchPeopleHint
  )
  expect(searchUsers).not.toHaveBeenCalled()
})

it('retains manually added collaborators while changing template roles and creates without an environment', async () => {
  const template = builtinCollaborationTemplates()[0].document
  const configure = vi.fn(async () => {})
  const create = vi.fn(async () => ({ id: 'created' }) as CollaborationProject)
  const store = new CollaborationTemplateStore({
    scope: 'local:fixture',
    ownerId: 1,
    persistence: { read: async () => [], write: async () => {} },
  })
  await act(async () =>
    root.render(
      <CollaborationTemplateContext value={store}>
        <ProjectCreateDialog
          targets={[{ location: 'cloud', create }]}
          defaultLocation="cloud"
          allowDingTalkAITable={false}
          labels={labels}
          initialTemplate={template}
          onClose={vi.fn()}
          onCreated={vi.fn()}
          resourceSetup={{
            location: 'cloud',
            currentUser: { id: 1, name: 'Me' },
            members: [
              {
                id: 2,
                user_id: 2,
                user_name: person.user_name,
                email: person.email,
                role: 'Developer',
              },
            ],
            agents: [agent],
            groups: [],
            executionEnvironments: [],
            executionEnvironmentError: 'Unavailable',
            configure,
          }}
        />
      </CollaborationTemplateContext>
    )
  )
  await click('collaboration-project-create-add-collaborator')
  await click('collaboration-project-create-member-2')
  await click('collaboration-project-create-add-collaborator')
  await click('collaboration-project-create-collaborator-tab-agents')
  await click('collaboration-project-create-agent-qa-agent')
  const customize = container.querySelector<HTMLElement>('[data-testid^="template-customize-"]')!
  if (customize.getAttribute('aria-expanded') !== 'true') await act(async () => customize.click())
  const role = document.querySelector<HTMLButtonElement>('[data-testid^="template-role-"]')!
  await act(async () => role.click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option =>
    option.textContent?.includes(person.user_name)
  )!
  expect(option).toBeTruthy()
  await act(async () => option.click())
  await click('cloud-project-create-confirm')
  expect(create).toHaveBeenCalledOnce()
  const selection = configure.mock.calls[0][1]
  expect(selection.memberUserIds).toContain(2)
  expect(selection.agentResourceIds).toContain(agent.id)
  expect(selection.executionEnvironmentDeviceIds).toEqual([])
  expect(selection.collaborationGroupDrafts).toHaveLength(1)
  expect(selection.collaborationGroupDrafts[0].leader).toMatchObject({
    kind: 'human',
    id: '2',
  })
})

it('keeps direct collaborators visible and removable after importing a group', async () => {
  const configure = vi.fn(async () => {})
  const create = vi.fn(async () => ({ id: 'created' }) as CollaborationProject)
  const manual = { ...agent, id: 'manual', name: 'Manual Agent' }
  const store = new CollaborationTemplateStore({
    scope: 'local:retained',
    ownerId: 1,
    persistence: { read: async () => [], write: async () => {} },
  })
  await act(async () =>
    root.render(
      <CollaborationTemplateContext value={store}>
        <ProjectCreateDialog
          targets={[{ location: 'cloud', create }]}
          defaultLocation="cloud"
          allowDingTalkAITable={false}
          labels={labels}
          onClose={vi.fn()}
          onCreated={vi.fn()}
          resourceSetup={{
            location: 'cloud',
            currentUser: { id: 1, name: 'Me' },
            members: [
              {
                id: 2,
                user_id: 2,
                user_name: person.user_name,
                email: person.email,
                role: 'Developer',
              },
            ],
            agents: [agent, manual],
            groups: [group],
            configure,
          }}
        />
      </CollaborationTemplateContext>
    )
  )
  await click('collaboration-project-create-add-collaborator')
  await click('collaboration-project-create-member-2')
  await click('collaboration-project-create-add-collaborator')
  await click('collaboration-project-create-collaborator-tab-agents')
  await click('collaboration-project-create-agent-manual')
  await click('collaboration-project-create-add-collaborator')
  await click('collaboration-project-create-collaborator-tab-groups')
  await click('collaboration-project-create-group-qa-group')
  const tokens = container.querySelector('.collaboration-project-create-collaborator-tokens')!
  expect(tokens.textContent).toContain('QA Person')
  expect(tokens.textContent).toContain('Manual Agent')
  for (const name of ['QA Person', 'Manual Agent'])
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`button[aria-label="取消 ${name}"]`)!.click()
    })
  expect(get('collaboration-project-create-group-summary').textContent).toContain('QA Group')
  await act(async () => {
    const field = get('cloud-project-name') as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      field,
      'Retained participants'
    )
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('cloud-project-create-confirm')
  const selection = configure.mock.calls[0][1]
  expect(selection.memberUserIds).not.toContain(2)
  expect(selection.agentResourceIds).not.toContain(manual.id)
})
