import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskSupervisorControl } from '@/components/layout/TaskSupervisorControl'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { selectSupervisorModel } from '../../e2e/desktop/modules/goal-flows.mjs'
import { runDesktopControlClient } from './automation'

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
    command: async (action: DesktopControlCommand['action'], selector: string, options = {}) => {
      next = { id: 'supervisor-selection', action, selector, ...options }
      const resultIndex = results.length
      await act(async () => runDesktopControlClient('http://127.0.0.1:43111', 'main'))
      const result = results[resultIndex]
      if (!result?.ok) throw new Error(result?.error ?? 'Missing control result')
      return result.value ?? ''
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mountSupervisor() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 10, 200, 30)
  )
  const onSet = vi.fn().mockResolvedValue(null)
  const onOpenChange = vi.fn()
  render(
    <TaskSupervisorControl
      open
      defaultInstructions="Keep the task focused"
      defaultModelSelection={{ modelName: 'previous-review-model', modelType: 'public' }}
      models={[
        { name: 'previous-review-model', type: 'public', namespace: 'default', resourceUserId: 0 },
        {
          name: 'desktop-e2e-public-model',
          type: 'public',
          namespace: 'default',
          resourceUserId: 0,
        },
      ]}
      onSet={onSet}
      onClear={vi.fn()}
      onOpenChange={onOpenChange}
    />
  )
  return { onSet, onOpenChange }
}

it('keeps the supervisor inert until its nested desktop model picker is dismissed', async () => {
  const { onSet, onOpenChange } = mountSupervisor()
  const control = nativeControl()
  await control.command('click', '[data-testid="model-selector-button"]')
  if (screen.queryByTestId('model-advanced-toggle')) {
    await control.command('click', '[data-testid="model-advanced-toggle"]')
  }
  await control.command('click', '[data-testid="model-option-desktop-e2e-public-model"]')

  const save = screen.getByTestId('task-supervisor-save-button')
  expect(save).toBeEnabled()
  expect(save.closest('[inert]')).not.toBeNull()
  expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
  expect(screen.getByTestId('task-supervisor-model')).toHaveAttribute(
    'data-value',
    'public:desktop-e2e-public-model:default:0'
  )
  await expect(
    control.command('click', '[data-testid="task-supervisor-save-button"]')
  ).rejects.toThrow('is disabled')
  expect(onSet).not.toHaveBeenCalled()

  await control.command('press', '[data-model-selector-layer="true"]', { key: 'Escape' })
  expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
  expect(save.closest('[inert]')).toBeNull()
  expect(screen.getByTestId('task-supervisor-dialog-overlay')).toBeInTheDocument()
  expect(onOpenChange).not.toHaveBeenCalled()
})

it('returns from the desktop model picker before saving the selected supervisor model', async () => {
  const { onSet, onOpenChange } = mountSupervisor()
  const control = nativeControl()
  await selectSupervisorModel(control)
  expect(screen.getByTestId('task-supervisor-model')).toHaveAttribute(
    'data-value',
    'public:desktop-e2e-public-model:default:0'
  )

  await control.command('click', '[data-testid="task-supervisor-save-button"]')

  expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
  expect(screen.getByTestId('task-supervisor-save-button').closest('[inert]')).toBeNull()
  expect(onSet).toHaveBeenCalledWith(
    'auto',
    'Keep the task focused',
    {
      modelName: 'desktop-e2e-public-model',
      modelType: 'public',
      options: expect.objectContaining({
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '0',
      }),
    },
    30
  )
  expect(onOpenChange).toHaveBeenCalledWith(false)
})
