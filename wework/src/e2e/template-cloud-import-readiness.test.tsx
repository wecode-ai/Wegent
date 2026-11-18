import { act, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectTemplateApplyDialog } from '../../../packages/collaboration/src/templates/ProjectTemplateApplyDialog'
import { builtinCollaborationTemplates } from '../../../packages/collaboration/src/templates/builtins'
import type { SharedWorkspaceApi } from '../../../packages/collaboration/src/ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../../../packages/collaboration/src/types'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { waitForCloudTemplateImport } from '../../e2e/desktop/scenarios/template-cloud-model-selection.scenario.mjs'
import { runDesktopControlClient } from './automation'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((success, failure) => {
    resolve = success
    reject = failure
  })
  return { promise, resolve, reject }
}

function nativeControl() {
  let next: DesktopControlCommand | undefined
  const results: Array<{ ok: boolean; value?: string; error?: string }> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/commands?')) {
      const command = next
      next = undefined
      return command ? Response.json(command) : new Response(null, { status: 410 })
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(init?.body)))
    return Response.json({})
  })
  return {
    async command(action: DesktopControlCommand['action'], selector: string, options = {}) {
      next = { id: 'template-cloud-import', action, selector, timeoutMs: 10_000, ...options }
      const index = results.length
      await runDesktopControlClient('http://127.0.0.1:43111', 'main')
      const result = results[index]
      if (!result?.ok) throw new Error(result?.error ?? 'Missing control result')
      return result.value ?? ''
    },
  }
}

async function mountImport() {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 10, 200, 30)
  )
  const agents = Array.from({ length: 6 }, () => deferred<{ id: string }>())
  const automation = deferred<{ id: string }>()
  const board = deferred<CollaborationProject>()
  const project = {
    id: 'cloud-project',
    access_role: 'Owner',
    project_store: 'backend',
    tags: [],
    version: 1,
  } as unknown as CollaborationProject
  let agentRequests = 0
  const createAgent = vi.fn(() => agents[agentRequests++].promise)
  const api = {
    projects: {
      get: vi.fn(async () => project),
      listCollaborationGroups: vi.fn(async () => []),
      createCollaborationGroup: vi.fn(async (_id: string, draft: object) => ({
        ...draft,
        id: 'group',
      })),
      update: vi.fn(() => board.promise),
    },
    members: { list: vi.fn(async () => [{ user_id: 7, user_name: 'Owner' }]) },
    agents: { list: vi.fn(async () => []), create: createAgent },
    automations: { list: vi.fn(async () => []), create: vi.fn(() => automation.promise) },
  }
  const applied = vi.fn()
  const document = builtinCollaborationTemplates()[0].document
  function Host() {
    const [open, setOpen] = useState(true)
    return (
      <div data-workspace-tab-content aria-hidden="false">
        {open && (
          <ProjectTemplateApplyDialog
            api={api as unknown as SharedWorkspaceApi}
            projectId={project.id}
            document={document}
            locale="zh-CN"
            currentUserId={7}
            onApplied={applied}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    )
  }
  await act(async () => render(<Host />))
  const control = nativeControl()
  await act(async () =>
    control.command('clickWhenEnabled', '[data-testid="template-bindings-apply"]')
  )
  expect(createAgent).toHaveBeenCalledTimes(1)
  return { control, agents, automation, board, project, api, applied }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('waits for all six Agents, routing and board writes beyond one ordinary UI step', async () => {
  const fixture = await mountImport()
  vi.useFakeTimers()
  let settled = false
  const waiting = waitForCloudTemplateImport(fixture.control, 30_000).then(
    () => {
      settled = true
      return { error: null }
    },
    (error: unknown) => {
      settled = true
      return { error }
    }
  )
  await act(async () => vi.advanceTimersByTimeAsync(10_016))
  expect(settled).toBe(false)
  expect(screen.getByTestId('template-bindings-apply')).toBeDisabled()
  for (const [index, agent] of fixture.agents.entries()) {
    await act(async () => agent.resolve({ id: `agent-${index}` }))
    expect(fixture.api.agents.create).toHaveBeenCalledTimes(Math.min(index + 2, 6))
    expect(settled).toBe(false)
  }
  expect(fixture.api.projects.createCollaborationGroup).toHaveBeenCalledOnce()
  expect(fixture.api.automations.create).toHaveBeenCalledOnce()
  await act(async () => fixture.automation.resolve({ id: 'routing' }))
  expect(fixture.api.projects.update).toHaveBeenCalledOnce()
  expect(settled).toBe(false)
  await act(async () => fixture.board.resolve(fixture.project))
  await act(async () => vi.advanceTimersByTimeAsync(100))
  expect((await waiting).error).toBeNull()
  expect(fixture.applied).toHaveBeenCalledWith(fixture.project)
  expect(screen.queryByTestId('collaboration-template-dialog')).not.toBeInTheDocument()
})

it('keeps a failed partial import open and reports the bounded completion failure', async () => {
  const fixture = await mountImport()
  vi.useFakeTimers()
  const waiting = waitForCloudTemplateImport(fixture.control, 30_000).then(
    () => ({ error: null }),
    (error: unknown) => ({ error })
  )
  await act(async () => fixture.agents[0].resolve({ id: 'persisted-agent' }))
  await act(async () => fixture.agents[1].reject(new Error('Agent creation unavailable')))
  expect(screen.getByTestId('template-bindings-apply')).toBeDisabled()
  expect(screen.getByRole('alert')).toBeVisible()
  await act(async () => vi.advanceTimersByTimeAsync(30_100))
  expect((await waiting).error).toMatchObject({
    message: 'Cloud template import did not close its dialog: "1"',
  })
  expect(fixture.api.agents.create).toHaveBeenCalledTimes(2)
  expect(fixture.api.projects.createCollaborationGroup).not.toHaveBeenCalled()
  expect(fixture.applied).not.toHaveBeenCalled()
  expect(screen.getByTestId('collaboration-template-dialog')).toBeInTheDocument()
})
