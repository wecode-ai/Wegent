// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup, CollaborationProject } from '../types'
import { ProjectCollaborationGroups } from '../project-manage/ProjectCollaborationGroups'
import { ProjectTemplateApplyDialog } from './ProjectTemplateApplyDialog'
import { ProjectTemplateImportRecovery } from './ProjectTemplateImportRecovery'
import { builtinCollaborationTemplates } from './builtins'
import { bindTemplate } from './document'
import { templateAgentBindings } from './agents'
import {
  canonicalTemplateImportJson,
  freezeProjectTemplateImportIntent,
  projectTemplateImportRequest,
} from './projectTemplateImportIntent'
import type {
  TemplateImportBegin,
  TemplateImportContext,
  TemplateImportOperation,
  TemplateImportStepKind,
} from './projectTemplateImportTypes'

vi.mock('../platform/WorkspaceResourceConfiguration', () => ({
  WorkspaceCollaborationGroupsConfiguration: ({ groups }: { groups: CollaborationGroup[] }) => (
    <div data-testid="groups-view">{groups.map(group => group.name).join(', ')}</div>
  ),
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function durableServer(projectId = 'project') {
  const document = structuredClone(builtinCollaborationTemplates()[0].document)
  const drafts = bindTemplate(document, templateAgentBindings(document))
  const operations = new Map<string, TemplateImportOperation>()
  const identities = new Map<string, string>()
  const resources = {
    agent: new Map<string, Record<string, unknown>>(),
    group: new Map<string, Record<string, unknown>>(),
    automation: new Map<string, Record<string, unknown>>(),
  }
  const commits = { agent: 0, group: 0, automation: 0, board: 0 }
  const loseResponse = new Set<TemplateImportStepKind>()
  const rejectWrite = new Map<TemplateImportStepKind, unknown>()
  let project = {
    id: projectId,
    access_role: 'Owner',
    project_store: 'cloud',
    version: 1,
    tags: [],
  } as unknown as CollaborationProject
  const snapshot = (operation: TemplateImportOperation): TemplateImportOperation =>
    structuredClone({
      ...operation,
      status: operation.steps.every(step => step.resourceId) ? 'completed' : 'pending',
    })
  const read = (kind: TemplateImportStepKind, id: string) =>
    kind === 'board' ? project : resources[kind].get(id)
  async function write(
    kind: TemplateImportStepKind,
    input: Record<string, unknown>,
    context?: TemplateImportContext
  ) {
    if (!context) throw new Error('An import write requires an operation context')
    const operation = operations.get(context.operationId)!
    const step = operation.steps.find(step => step.kind === kind && step.key === context.stepKey)!
    if (step.resourceId) return structuredClone(read(kind, step.resourceId))
    if (rejectWrite.has(kind)) {
      const cause = rejectWrite.get(kind)
      rejectWrite.delete(kind)
      throw cause
    }
    commits[kind]++
    const id = kind === 'board' ? projectId : `${kind}-${commits[kind]}`
    if (kind === 'board')
      project = {
        ...project,
        version: project.version + 1,
        tags: input.tags as string[],
        board_views: input.boardViews as CollaborationProject['board_views'],
      }
    else resources[kind].set(id, { ...input, id })
    step.resourceId = id
    if (loseResponse.delete(kind)) throw new TypeError('Failed to fetch')
    return structuredClone(read(kind, id))
  }
  const client = (): SharedWorkspaceApi =>
    ({
      templateImports: {
        begin: vi.fn(async (_projectId: string, input: TemplateImportBegin) => {
          const identity = canonicalTemplateImportJson(input)
          let id = identities.get(identity)
          if (!id) {
            id = `private-operation-${operations.size + 1}`
            identities.set(identity, id)
            operations.set(id, {
              id,
              projectId,
              protocolVersion: 1,
              status: 'pending',
              intent: structuredClone(input.intent),
              steps: structuredClone(input.steps),
            })
          }
          return snapshot(operations.get(id)!)
        }),
        get: vi.fn(async (_projectId: string, id: string) => snapshot(operations.get(id)!)),
        list: vi.fn(async () =>
          [...operations.values()]
            .map(snapshot)
            .filter(operation => operation.status === 'pending')
            .map(({ intent: _intent, ...metadata }) => metadata)
        ),
      },
      projects: {
        get: vi.fn(async () => structuredClone(project)),
        listCollaborationGroups: vi.fn(async () =>
          [...resources.group.values()].map(group => structuredClone(group))
        ),
        createCollaborationGroup: vi.fn(
          async (
            _projectId: string,
            input: Record<string, unknown>,
            context?: TemplateImportContext
          ) => write('group', input, context)
        ),
        update: vi.fn(
          async (
            _projectId: string,
            input: Record<string, unknown>,
            context?: TemplateImportContext
          ) => write('board', input, context)
        ),
      },
      agents: {
        list: vi.fn(async () => [...resources.agent.values()].map(agent => structuredClone(agent))),
        create: vi.fn(
          async (
            _projectId: string,
            input: Record<string, unknown>,
            context?: TemplateImportContext
          ) => write('agent', input, context)
        ),
      },
      members: { list: vi.fn(async () => [{ user_id: 7, user_name: 'Owner' }]) },
      automations: {
        list: vi.fn(async () =>
          [...resources.automation.values()].map(rule => structuredClone(rule))
        ),
        create: vi.fn(
          async (
            _projectId: string,
            input: Record<string, unknown>,
            context?: TemplateImportContext
          ) => write('automation', input, context)
        ),
      },
    }) as unknown as SharedWorkspaceApi
  return { client, document, drafts, operations, resources, commits, loseResponse, rejectWrite }
}

async function click(testId: string) {
  await act(async () =>
    container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click()
  )
}

async function chooseImport(id: string) {
  await click('template-import-recovery-open')
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="template-import-recovery-select"]'
    )!
    select.value = id
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function renderDialog(
  api: SharedWorkspaceApi,
  server: ReturnType<typeof durableServer>,
  applied = vi.fn()
) {
  await act(async () =>
    root.render(
      <ProjectTemplateApplyDialog
        api={api}
        projectId="project"
        document={server.document}
        locale="zh-CN"
        onApplied={applied}
        onClose={() => root.render(null)}
      />
    )
  )
  return applied
}

it.each(['dialog', 'groups'] as const)(
  'resumes the same six-Agent import from a fresh client through the %s entry after a lost first response',
  async entry => {
    const server = durableServer()
    server.loseResponse.add('agent')
    const first = server.client()
    await renderDialog(first, server)
    expect(first.templateImports!.list).toHaveBeenCalledOnce()
    await click('template-bindings-apply')
    expect(server.commits.agent).toBe(1)
    expect(container.textContent).toContain('恢复')
    await click('collaboration-template-close')
    expect(container.querySelector('dialog')).toBeNull()
    const second = server.client()
    const applied = vi.fn()
    if (entry === 'dialog') await renderDialog(second, server, applied)
    else
      await act(async () =>
        root.render(
          <ProjectCollaborationGroups
            api={second}
            projectId="project"
            members={[]}
            agents={[]}
            locale="en"
            canManage
            onProjectChanged={applied}
          />
        )
      )
    expect(second.templateImports!.get).not.toHaveBeenCalled()
    const operationId = [...server.operations.keys()][0]
    await chooseImport(operationId)
    expect(second.templateImports!.get).toHaveBeenCalledOnce()
    const preview = container.querySelector(
      '[data-testid="template-import-recovery-preview"]'
    )!.textContent!
    expect(preview).toContain(server.drafts[0].name)
    expect(preview).toContain(entry === 'dialog' ? '6 名成员' : '6 members')
    expect(container.textContent).not.toContain(operationId)
    await click('template-import-recovery-resume')
    expect(second.templateImports!.begin).not.toHaveBeenCalled()
    expect(server.commits).toEqual({ agent: 6, group: 1, automation: 1, board: 1 })
    expect(applied).toHaveBeenCalledOnce()
    expect([...server.resources.automation.values()][0].name).toContain('新任务')
  }
)

it('offers immediate explicit recovery after its own group name enters the refreshed list', async () => {
  const server = durableServer()
  server.rejectWrite.set('automation', Object.assign(new Error('Internal error'), { status: 500 }))
  const api = server.client()
  const applied = await renderDialog(api, server)
  expect(container.querySelector('[data-testid="template-import-recovery-open"]')).toBeNull()
  await click('template-bindings-apply')
  expect(server.commits).toEqual({ agent: 6, group: 1, automation: 0, board: 0 })
  expect(container.querySelector('[data-testid="template-import-recovery-open"]')).not.toBeNull()
  await click('template-bindings-apply')
  expect(api.templateImports!.begin).toHaveBeenCalledOnce()
  expect(server.commits.agent).toBe(6)
  expect(server.commits.group).toBe(1)
  await chooseImport([...server.operations.keys()][0])
  await click('template-import-recovery-resume')
  expect(server.commits).toEqual({ agent: 6, group: 1, automation: 1, board: 1 })
  expect(applied).toHaveBeenCalledOnce()
})

it('keeps the editable draft usable when pending discovery fails and retries only the read', async () => {
  const server = durableServer()
  const api = server.client()
  vi.mocked(api.templateImports!.list).mockRejectedValueOnce(
    Object.assign(new Error('secret body'), { status: 500 })
  )
  await renderDialog(api, server)
  expect(
    container.querySelector('[data-testid="template-import-recovery-error"]')!.textContent
  ).toContain('服务端')
  expect(container.textContent).not.toContain('secret body')
  await act(async () => {
    const name = container.querySelector<HTMLInputElement>(
      '[data-testid="template-group-name-main"]'
    )!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      name,
      'Retained draft'
    )
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(
    container.querySelector<HTMLButtonElement>('[data-testid="template-bindings-apply"]')!.disabled
  ).toBe(false)
  await click('template-import-recovery-refresh')
  expect(api.templateImports!.list).toHaveBeenCalledTimes(2)
  expect(api.templateImports!.begin).not.toHaveBeenCalled()
  expect(server.commits.agent).toBe(0)
  expect(
    container.querySelector<HTMLInputElement>('[data-testid="template-group-name-main"]')!.value
  ).toBe('Retained draft')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

it.each(['api', 'project', 'locale', 'unmount'] as const)(
  'ignores a private preview response after a %s scope change',
  async change => {
    const first = durableServer()
    const api = first.client()
    const intent = await freezeProjectTemplateImportIntent(first.document, first.drafts, 'zh-CN')
    const operation = await api.templateImports!.begin(
      'project',
      projectTemplateImportRequest(intent)
    )
    const pending = deferred<TemplateImportOperation>()
    vi.mocked(api.templateImports!.get).mockReturnValueOnce(pending.promise)
    const resumed = vi.fn()
    const draw = (
      value: SharedWorkspaceApi,
      projectId = 'project',
      locale: 'zh-CN' | 'en' = 'zh-CN'
    ) =>
      act(async () =>
        root.render(
          <ProjectTemplateImportRecovery
            api={value}
            projectId={projectId}
            locale={locale}
            onResumed={resumed}
          />
        )
      )
    await draw(api)
    await chooseImport(operation.id)
    expect(container.querySelector('[data-testid="template-import-recovery-preview"]')).toBeNull()
    if (change === 'unmount') await act(async () => root.render(null))
    else if (change === 'locale') await draw(api, 'project', 'en')
    else
      await draw(
        durableServer(change === 'project' ? 'other-project' : 'project').client(),
        change === 'project' ? 'other-project' : 'project'
      )
    await act(async () => pending.resolve(operation))
    expect(container.querySelector('[data-testid="template-import-recovery-preview"]')).toBeNull()
    expect(resumed).not.toHaveBeenCalled()
    expect(first.commits.agent).toBe(0)
  }
)

it.each(['api', 'project', 'locale', 'unmount'] as const)(
  'does not publish a resumed old operation after a %s scope change',
  async change => {
    const server = durableServer()
    const api = server.client()
    const intent = await freezeProjectTemplateImportIntent(server.document, server.drafts, 'zh-CN')
    const operation = await api.templateImports!.begin(
      'project',
      projectTemplateImportRequest(intent)
    )
    const resumed = vi.fn(async () => {})
    const refreshed = vi.fn()
    const draw = (
      value: SharedWorkspaceApi,
      projectId = 'project',
      locale: 'zh-CN' | 'en' = 'zh-CN'
    ) =>
      act(async () =>
        root.render(
          <ProjectTemplateImportRecovery
            api={value}
            projectId={projectId}
            locale={locale}
            onResumed={resumed}
            onGroupsRefreshed={refreshed}
          />
        )
      )
    await draw(api)
    await chooseImport(operation.id)
    const pending = deferred<TemplateImportOperation>()
    vi.mocked(api.templateImports!.get).mockReturnValueOnce(pending.promise)
    const completed = deferred<CollaborationProject>()
    const get = vi.mocked(api.projects.get).getMockImplementation()!
    vi.mocked(api.projects.get).mockImplementation(async id => {
      const project = await get(id)
      if (server.commits.board) completed.resolve(project)
      return project
    })
    await click('template-import-recovery-resume')
    if (change === 'unmount') await act(async () => root.render(null))
    else if (change === 'locale') await draw(api, 'project', 'en')
    else
      await draw(
        durableServer(change === 'project' ? 'other-project' : 'project').client(),
        change === 'project' ? 'other-project' : 'project'
      )
    await act(async () => {
      pending.resolve(operation)
      await completed.promise
    })
    expect(server.commits).toEqual({ agent: 6, group: 1, automation: 1, board: 1 })
    expect(resumed).not.toHaveBeenCalled()
    expect(refreshed).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="template-import-recovery-preview"]')).toBeNull()
  }
)
