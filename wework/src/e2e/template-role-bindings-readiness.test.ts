import { expect, test, vi } from 'vitest'

import { fillTemplateRoleBindings } from '../../e2e/desktop/scenarios/collaboration-templates.scenario.mjs'

const visible = { visible: true }
const customize =
  '[data-workspace-tab-content][aria-hidden="false"] [data-testid="template-customize-main"]'
const role = (index: number) =>
  `[data-workspace-tab-content][aria-hidden="false"] [data-testid="template-role-main-role-${index}"]`
const humanOption = '[id="role-0"] [role="option"][data-value^="human:"]'
const agentChoice = (index: number) => `agent:template-agent:main-role-${index}`

function createControl(collapsed = false, onOption?: (selector: string) => Promise<void>) {
  let open = !collapsed
  let activeRole: number | null = null
  const command = vi.fn(async (action: string, selector: string, options?: { value?: string }) => {
    if (action === 'getAttribute' && selector === customize) return String(open)
    if (action === 'clickWhenEnabled' && selector === customize) {
      open = true
      return
    }
    const roleIndex = /template-role-main-role-(\d+)/.exec(selector)?.[1]
    if (action === 'clickWhenEnabled' && roleIndex != null) {
      if (!open) throw new Error('Template customization is still closed')
      if (activeRole !== null) throw new Error('Previous role is still open')
      activeRole = Number(roleIndex)
    }
    if (action === 'getAttribute' && options?.value === 'aria-controls') {
      if (activeRole == null || selector !== role(activeRole))
        throw new Error('Role does not own the active listbox')
      return `role-${activeRole}`
    }
    if (action === 'waitFor' && selector === humanOption) await onOption?.(selector)
    if (action === 'clickWhenEnabled' && selector.includes('[role="option"]')) {
      if (!selector.startsWith(`[id="role-${activeRole}"]`))
        throw new Error('Option does not belong to the active role')
      activeRole = null
    }
    if (action === 'select') {
      if (activeRole !== null) throw new Error('Previous role is still open')
      await onOption?.(options?.value ?? '')
    }
  })
  return { command }
}

test.each([
  ['human coordinator', humanOption, role(1)],
  ['embedded Agent', agentChoice(1), role(2)],
])('waits for the %s before opening the next role', async (_label, delayed, next) => {
  let release!: () => void
  let reached!: () => void
  const catalog = new Promise<void>(resolve => {
    release = resolve
  })
  const waiting = new Promise<void>(resolve => {
    reached = resolve
  })
  const control = createControl(false, async selector => {
    if (selector !== delayed) return
    reached()
    await catalog
  })
  const result = fillTemplateRoleBindings(control, 3)
  expect(await Promise.race([waiting.then(() => 'waiting'), result.then(() => 'finished')])).toBe(
    'waiting'
  )
  expect(control.command).not.toHaveBeenCalledWith('select', next, expect.anything())
  release()
  await result
  expect(control.command).toHaveBeenCalledWith('clickWhenEnabled', humanOption, visible)
  expect(control.command).toHaveBeenCalledWith('select', role(1), { value: agentChoice(1) })
  expect(control.command).toHaveBeenCalledWith('select', role(2), { value: agentChoice(2) })
})

test('propagates an unavailable Agent catalog without opening the next role or retrying', async () => {
  const unavailable = new Error('Current-device Agent did not become available')
  const control = createControl(false, async selector => {
    if (selector === agentChoice(1)) throw unavailable
  })
  await expect(fillTemplateRoleBindings(control, 3)).rejects.toBe(unavailable)
  expect(control.command).not.toHaveBeenCalledWith('select', role(2), expect.anything())
  expect(
    control.command.mock.calls.filter(
      ([action, selector]) => action === 'select' && selector === role(1)
    )
  ).toHaveLength(1)
})

test('opens collapsed template customization before reading its role catalog', async () => {
  const control = createControl(true)
  await expect(fillTemplateRoleBindings(control, 3)).resolves.toBeUndefined()
  expect(control.command).toHaveBeenCalledWith('clickWhenEnabled', customize, visible)
  expect(control.command).toHaveBeenCalledWith('clickWhenEnabled', humanOption, visible)
  expect(control.command).toHaveBeenCalledWith('select', role(2), { value: agentChoice(2) })
})
