import { expect, test, vi } from 'vitest'

import { reloadMainWindow } from '../../e2e/desktop/modules/workspace-flows.mjs'
import { createBarrier } from '../test/async-barrier'

test('normal reload waits for the native handoff and the replacement control client', async () => {
  const handoff = createBarrier()
  const reconnect = createBarrier()
  const reconnectRequested = createBarrier()
  const command = vi.fn((action: string) => {
    if (action === 'getStartupSplashSnapshot') {
      return handoff.promise.then(() => JSON.stringify({ state: 'closed' }))
    }
    expect(action).toBe('reloadMainWindow')
    return Promise.resolve('')
  })
  const awaitReadyAfter = vi.fn((readyCount: number) => {
    expect(readyCount).toBe(4)
    reconnectRequested.release()
    return reconnect.promise
  })
  let finished = false
  const reloading = reloadMainWindow(
    { command, readyCount: 4, awaitReadyAfter },
    'The replacement renderer did not reconnect'
  ).then(() => {
    finished = true
  })

  expect(command.mock.calls.map(([action]) => action)).toEqual(['getStartupSplashSnapshot'])
  expect(awaitReadyAfter).not.toHaveBeenCalled()
  handoff.release()
  await reconnectRequested.promise

  expect(command.mock.calls.map(([action]) => action)).toEqual([
    'getStartupSplashSnapshot',
    'reloadMainWindow',
  ])
  expect(awaitReadyAfter).toHaveBeenCalledOnce()
  expect(finished).toBe(false)
  reconnect.release()
  await reloading
  expect(finished).toBe(true)
})
