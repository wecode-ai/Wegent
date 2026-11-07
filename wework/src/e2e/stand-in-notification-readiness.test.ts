// @vitest-environment node

import { expect, test, vi } from 'vitest'
import { sendStandInNotificationFollowUp } from '../../e2e/desktop/modules/stand-in-flows.mjs'
import { createBarrier } from '../test/async-barrier'

const content = '[data-workspace-tab-content][aria-hidden="false"]'
const pane = `${content} [data-active-workbench-pane="true"]`
const composer = `${pane} [data-testid="chat-message-input"][contenteditable="true"]`
const send = `${pane} [data-testid="send-message-button"]`

test('notification follow-up waits for its active pane button and submits once without IME Enter', async () => {
  const waiting = createBarrier()
  const ready = createBarrier()
  const submitted = vi.fn()
  const calls: string[] = []
  const verification = sendStandInNotificationFollowUp(
    {
      async command(action: string, selector: string, options: unknown) {
        calls.push(action)
        if (action === 'waitFor') {
          expect(selector).toBe(composer)
          expect(options).toEqual({ visible: true })
        } else if (action === 'fill') {
          expect(selector).toBe(composer)
          expect(options).toEqual({ value: 'Continue the original session' })
        } else {
          expect(action).toBe('clickWhenEnabled')
          expect(selector).toBe(send)
          expect(options).toEqual({ visible: true })
          waiting.release()
          await ready.promise
          submitted()
        }
      },
    },
    content,
    'Continue the original session'
  )
  try {
    await Promise.race([waiting.promise, verification])
    expect(calls).toEqual(['waitFor', 'fill', 'clickWhenEnabled'])
    expect(submitted).not.toHaveBeenCalled()
  } finally {
    ready.release()
  }
  await verification
  expect(submitted).toHaveBeenCalledOnce()
})

test('notification follow-up propagates unavailable send controls without a second submission', async () => {
  const command = vi.fn(async (action: string) => {
    if (action === 'clickWhenEnabled') throw new Error('Send control stayed unavailable')
  })

  await expect(sendStandInNotificationFollowUp({ command }, content, 'Follow up')).rejects.toThrow(
    'Send control stayed unavailable'
  )
  expect(command.mock.calls.map(([action]) => action)).toEqual([
    'waitFor',
    'fill',
    'clickWhenEnabled',
  ])
})
