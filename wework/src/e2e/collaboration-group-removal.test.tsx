import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ProjectCollaborationGroups } from '../../../packages/collaboration/src/project-manage/ProjectCollaborationGroups'
import type { SharedWorkspaceApi } from '../../../packages/collaboration/src/ports/SharedWorkspaceApi'
import type {
  CollaborationGroup,
  CollaborationProject,
} from '../../../packages/collaboration/src/types'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import type { DesktopControlResult } from './desktop-control-command'
import { runDesktopControlClient } from './automation'
import { waitForCollaborationGroupRemoval } from '../../e2e/desktop/modules/collaboration-group-removal.mjs'

const ownerSelector = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = (testId: string) => `${ownerSelector} [data-testid="${testId}"]`
const refreshedProject = { id: 'project', version: 2 } as CollaborationProject

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function group(id: string, owner: 'workspace' | 'project'): CollaborationGroup {
  return {
    id,
    workspace_id: 'workspace',
    owner_type: owner,
    owner_id: owner,
    name: `${owner} group`,
    description: '',
    leader: { kind: 'human', id: '1' },
    members: [{ kind: 'human', id: '1' }],
    coordination_mode: 'manager',
    stages: [],
    version: 1,
    created_by_user_id: 1,
    created_at: '',
    updated_at: '',
  }
}

function desktopControl(onStarted?: (command: DesktopControlCommand) => void) {
  return {
    async command(
      action: DesktopControlCommand['action'],
      target: string,
      options: Partial<DesktopControlCommand> = {}
    ) {
      const command = { id: crypto.randomUUID(), action, selector: target, ...options }
      let delivered = false
      let result: DesktopControlResult | undefined
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (url.includes('/commands?')) {
          if (delivered) return new Response(null, { status: 410 })
          delivered = true
          return new Response(JSON.stringify(command))
        }
        if (url.endsWith('/started')) onStarted?.(command)
        if (url.endsWith('/results')) result = JSON.parse(String(init?.body))
        return new Response('{}')
      })
      await runDesktopControlClient('http://127.0.0.1:43111', 'main')
      expect(result).toBeDefined()
      if (!result!.ok) throw new Error(result!.error)
      return result!.value ?? ''
    },
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  container.setAttribute('data-workspace-tab-content', '')
  container.setAttribute('aria-hidden', 'false')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('waits for the removal operation before opening the next group confirmation', async () => {
  const source = group('78', 'workspace')
  const projectOwned = group('82', 'project')
  let persistedGroups = [source, projectOwned]
  const refresh = deferred<CollaborationProject>()
  const remove = vi.fn(async (_projectId: string, groupId: string) => {
    persistedGroups = persistedGroups.filter(candidate => candidate.id !== groupId)
  })
  const listGroups = vi.fn(async () => persistedGroups)
  const sourceGroups = vi.fn(async () => [source])
  const api = {
    projects: {
      listCollaborationGroups: listGroups,
      removeCollaborationGroup: remove,
      get: vi.fn(() => refresh.promise),
    },
    agents: { list: vi.fn(async () => []) },
    members: { list: vi.fn(async () => []) },
    workspaces: { listCollaborationGroups: sourceGroups },
  } as unknown as SharedWorkspaceApi
  await act(async () => {
    root.render(
      <ProjectCollaborationGroups
        api={api}
        projectId="project"
        workspaceId="workspace"
        members={[]}
        agents={[]}
        locale="en"
        canManage
        onProjectChanged={vi.fn()}
      />
    )
  })
  const waiting = deferred<void>()
  const control = desktopControl(command => {
    if (command.action === 'waitFor') waiting.resolve()
  })
  const click = (testId: string) =>
    act(async () => {
      await control.command('click', selector(testId))
    })

  await click('collaboration-group-remove-78')
  await click('collaboration-group-delete-cancel')
  expect(remove).not.toHaveBeenCalled()
  expect(await listGroups()).toEqual([source, projectOwned])
  await click('collaboration-group-remove-78')
  await click('collaboration-group-delete-confirm')
  expect(remove).toHaveBeenCalledExactlyOnceWith('project', '78')
  expect(await listGroups()).toEqual([projectOwned])
  expect(await sourceGroups()).toEqual([source])
  expect(
    container.querySelector('[data-testid="collaboration-group-delete-dialog"]')
  ).toHaveAttribute('aria-busy', 'true')
  expect(
    container.querySelector('[data-testid="collaboration-group-remove-82"]')?.closest('[inert]')
  ).not.toBeNull()

  await expect(control.command('click', selector('collaboration-group-remove-82'))).rejects.toThrow(
    'is disabled'
  )
  let completed = false
  const removal = waitForCollaborationGroupRemoval(control, ownerSelector, source.id).then(() => {
    completed = true
  })
  await act(async () => waiting.promise)
  expect(completed).toBe(false)
  expect(remove).toHaveBeenCalledTimes(1)
  await act(async () => refresh.resolve(refreshedProject))
  await removal
  expect(completed).toBe(true)
  expect(container.querySelector('[data-testid="collaboration-group-78"]')).toBeNull()
  expect(container.querySelector('[data-testid="collaboration-group-delete-dialog"]')).toBeNull()
  expect(
    container.querySelector('[data-testid="collaboration-group-remove-82"]')?.closest('[inert]')
  ).toBeNull()
  expect(container.querySelector('[data-testid="collaboration-group-available-78"]')).not.toBeNull()
  await click('collaboration-group-remove-82')
  expect(
    container.querySelector('[data-testid="collaboration-group-delete-dialog"]')?.textContent
  ).toContain(projectOwned.name)
  expect(remove).toHaveBeenCalledTimes(1)
  await click('collaboration-group-delete-cancel')
  expect(await listGroups()).toEqual([projectOwned])
  expect(await sourceGroups()).toEqual([source])
  await click('collaboration-group-remove-82')
  await click('collaboration-group-delete-confirm')
  await waitForCollaborationGroupRemoval(control, ownerSelector, projectOwned.id)
  expect(remove).toHaveBeenCalledTimes(2)
  expect(remove).toHaveBeenLastCalledWith('project', '82')
  expect(await listGroups()).toEqual([])
  expect(await sourceGroups()).toEqual([source])
  expect(container.querySelector('[data-testid="collaboration-group-available-78"]')).not.toBeNull()
})
