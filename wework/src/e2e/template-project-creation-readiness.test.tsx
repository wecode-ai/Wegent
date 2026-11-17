import { fireEvent, render, screen } from '@testing-library/react'
import { ProjectCreateDialog, projectCreateLabels } from '@wegent/collaboration/project-create'
import type { CollaborationProject } from '@wegent/collaboration'
import { act, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import {
  cancelTemplateProjectDraft,
  waitForTemplateProjectCreation,
} from '../../e2e/desktop/scenarios/collaboration-templates.scenario.mjs'
import { runDesktopControlClient } from './automation'

const confirmId = 'collaboration-project-create-confirm'
const selector = `[data-workspace-tab-content][aria-hidden="false"] [data-testid="${confirmId}"]`
const project = {
  id: 'template-project',
  name: 'Template project',
} as CollaborationProject

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, resolve, reject }
}

function mountCreation() {
  const creation = deferred<CollaborationProject>()
  const configuration = deferred<CollaborationProject>()
  const configure = vi.fn(() => configuration.promise)
  const onCreated = vi.fn()
  function Host() {
    const [created, setCreated] = useState<CollaborationProject | null>(null)
    return (
      <div data-workspace-tab-content aria-hidden="false">
        {created ? (
          <h1 data-testid="cloud-project-header-title">{created.name}</h1>
        ) : (
          <ProjectCreateDialog
            targets={[{ location: 'cloud', create: () => creation.promise }]}
            defaultLocation="cloud"
            labels={projectCreateLabels.en}
            allowDingTalkAITable={false}
            testIds={{ confirm: confirmId }}
            resourceSetup={{
              location: 'cloud',
              currentUser: { id: 1, name: 'Owner' },
              members: [],
              agents: [],
              groups: [],
              configure,
            }}
            onClose={vi.fn()}
            onCreated={value => {
              onCreated(value)
              setCreated(value)
            }}
          />
        )}
      </div>
    )
  }
  render(<Host />)
  fireEvent.change(screen.getByTestId('cloud-project-name'), { target: { value: project.name } })
  fireEvent.click(screen.getByTestId(confirmId))
  return { creation, configuration, configure, onCreated }
}

function nativeControl() {
  const firstRead = deferred<void>()
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
    firstRead: firstRead.promise,
    command: vi.fn(
      async (action: DesktopControlCommand['action'], target: string, options = {}) => {
        next = { id: 'creation-readiness', action, selector: target, ...options }
        const resultIndex = results.length
        await runDesktopControlClient('http://127.0.0.1:43111', 'main')
        const result = results[resultIndex]
        if (!result?.ok) throw new Error(result?.error ?? 'Missing control result')
        firstRead.resolve()
        return result.value ?? ''
      }
    ),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('discards the template project draft before returning to template discovery', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 10, 200, 30)
  )
  const create = vi.fn()
  const onClose = vi.fn()
  const discover = vi.fn()
  function Host() {
    const [open, setOpen] = useState(true)
    return (
      <div data-workspace-tab-content aria-hidden="false">
        <button data-testid="template-tab-discover" onClick={discover}>
          Discover
        </button>
        {open && (
          <ProjectCreateDialog
            targets={[{ location: 'cloud', create }]}
            defaultLocation="cloud"
            labels={projectCreateLabels.en}
            allowDingTalkAITable={false}
            onClose={() => {
              onClose()
              setOpen(false)
            }}
            onCreated={vi.fn()}
          />
        )}
      </div>
    )
  }
  render(<Host />)
  fireEvent.change(screen.getByTestId('cloud-project-name'), {
    target: { value: 'Account template project' },
  })
  const native = nativeControl()
  const control = {
    async command(...args: Parameters<typeof native.command>) {
      let value = ''
      await act(async () => {
        value = await native.command(...args)
      })
      return value
    },
  }

  await cancelTemplateProjectDraft(control)
  await control.command('click', '[data-testid="template-tab-discover"]')

  expect(screen.queryByTestId('collaboration-project-create-dialog')).not.toBeInTheDocument()
  expect(onClose).toHaveBeenCalledOnce()
  expect(discover).toHaveBeenCalledOnce()
  expect(create).not.toHaveBeenCalled()
})

it('waits for deferred creation and configuration while the mounted confirm is outside the viewport', async () => {
  const { creation, configuration, configure, onCreated } = mountCreation()
  const confirm = screen.getByTestId(confirmId)
  vi.spyOn(confirm, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 2000, 100, 30))
  const control = nativeControl()
  // The real native visibility predicate accepts an offscreen, still-mounted control.
  await control.command('waitFor', selector, { visible: false, timeoutMs: 500 })
  expect(confirm.isConnected).toBe(true)
  expect(confirm).toBeDisabled()

  const creationControl = nativeControl()
  let settled = false
  const waiting = waitForTemplateProjectCreation(creationControl, 500).then(() => {
    settled = true
  })
  await act(async () => creationControl.firstRead)
  expect(settled).toBe(false)
  expect(configure).not.toHaveBeenCalled()
  await act(async () => creation.resolve(project))
  expect(configure).toHaveBeenCalledOnce()
  expect(settled).toBe(false)
  expect(onCreated).not.toHaveBeenCalled()
  expect(confirm.isConnected).toBe(true)

  await act(async () => configuration.resolve(project))
  await waiting
  expect(onCreated).toHaveBeenCalledWith(project)
  expect(confirm.isConnected).toBe(false)
  expect(screen.getByTestId('cloud-project-header-title')).toHaveTextContent(project.name)
})

it('does not report a failed resource configuration as completed creation', async () => {
  const { creation, configuration, onCreated } = mountCreation()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const control = nativeControl()
  const waiting = waitForTemplateProjectCreation(control, 300).then(
    () => ({ error: null }),
    (error: unknown) => ({ error })
  )
  await act(async () => creation.resolve(project))
  await act(async () => configuration.reject(new Error('Template resource failed')))
  expect((await waiting).error).toMatchObject({
    message: 'Template project creation did not close its dialog: "1"',
  })
  expect(onCreated).not.toHaveBeenCalled()
  expect(screen.getByTestId(confirmId)).toBeInTheDocument()
  expect(screen.queryByTestId('cloud-project-header-title')).not.toBeInTheDocument()
  expect(warning).toHaveBeenCalled()
})
