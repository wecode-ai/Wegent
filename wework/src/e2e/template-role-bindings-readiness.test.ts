import { expect, test, vi } from 'vitest'

import { fillTemplateRoleBindings } from '../../e2e/desktop/scenarios/collaboration-templates.scenario.mjs'

const role = (index: number) =>
  `[data-workspace-tab-content][aria-hidden="false"] [data-testid="template-role-main-role-${index}"]`

test('waits for the current-device Agent catalog before binding every non-human template role', async () => {
  let catalogReady = false
  let releaseCatalog!: () => void
  let reachedWait!: () => void
  const catalog = new Promise<void>(resolve => {
    releaseCatalog = resolve
  })
  const waiting = new Promise<void>(resolve => {
    reachedWait = resolve
  })
  const command = vi.fn(async (action: string, selector: string) => {
    if (action === 'getAttribute') return 'human:1'
    if (action === 'waitFor' && selector === role(1)) {
      reachedWait()
      await catalog
    }
    if (action === 'select' && selector !== role(0) && !catalogReady) {
      throw new Error('The mounted role selector has no Agent candidates yet')
    }
  })
  const result = fillTemplateRoleBindings({ command }, 3).then(
    () => ({ error: null }),
    (error: unknown) => ({ error })
  )

  const milestone = await Promise.race([
    waiting.then(() => 'waiting'),
    result.then(() => 'finished'),
  ])
  expect(milestone).toBe('waiting')
  expect(command).not.toHaveBeenCalledWith('select', role(1), expect.anything())
  catalogReady = true
  releaseCatalog()
  expect((await result).error).toBeNull()
  expect(command).toHaveBeenCalledWith('select', role(0), { value: 'human:1' })
  for (const index of [1, 2]) {
    expect(command).toHaveBeenCalledWith('waitFor', role(index), { text: '当前设备智能体' })
    expect(command).toHaveBeenCalledWith('select', role(index), {
      by: 'label',
      value: '当前设备智能体',
    })
  }
})

test('propagates an unavailable Agent catalog without changing the binding or repeating selection', async () => {
  const unavailable = new Error('Current-device Agent did not become available')
  const command = vi.fn(async (action: string) => {
    if (action === 'getAttribute') return 'human:1'
    if (action === 'waitFor') throw unavailable
  })

  await expect(fillTemplateRoleBindings({ command }, 3)).rejects.toBe(unavailable)
  expect(command.mock.calls.filter(([action]) => action === 'select')).toHaveLength(1)
})
