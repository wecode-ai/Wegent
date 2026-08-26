import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SystemSleepController } from './system-sleep-controller.js'

const mocks = vi.hoisted(() => ({
  isStarted: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}))

vi.mock('electron', () => ({
  powerSaveBlocker: mocks,
}))

describe('SystemSleepController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.start.mockReturnValue(42)
    mocks.isStarted.mockImplementation(id => id === 42)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('holds one system sleep blocker while tasks are active', () => {
    const controller = new SystemSleepController()

    controller.setTaskActive('main', true)
    controller.setTaskActive('main', true)

    expect(mocks.start).toHaveBeenCalledOnce()
    expect(mocks.start).toHaveBeenCalledWith('prevent-app-suspension')
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  test('releases the blocker when tasks settle or the preference is disabled', () => {
    const controller = new SystemSleepController()

    controller.setTaskActive('main', true)
    controller.setEnabled(false)

    expect(mocks.stop).toHaveBeenCalledWith(42)

    controller.setEnabled(true)
    expect(mocks.start).toHaveBeenCalledTimes(2)

    controller.setTaskActive('main', false)
    expect(mocks.stop).toHaveBeenCalledTimes(2)
  })

  test('keeps the blocker while another desktop surface still has active tasks', () => {
    const controller = new SystemSleepController()

    controller.setTaskActive('main', true)
    controller.setTaskActive('popout-window', false)
    controller.setTaskActive('workspace-project', true)
    controller.setTaskActive('main', false)

    expect(mocks.start).toHaveBeenCalledOnce()
    expect(mocks.stop).not.toHaveBeenCalled()

    controller.setTaskActive('workspace-project', false)
    expect(mocks.stop).toHaveBeenCalledWith(42)
  })

  test('tracks executor response events independently from renderer surfaces', () => {
    const controller = new SystemSleepController()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    controller.handleExecutorEvent('response.created', { taskId: 'task-1' })
    const logCallsAfterCreated = log.mock.calls.length
    for (let index = 0; index < 2_200; index += 1) {
      controller.handleExecutorEvent('response.block.updated', { taskId: 'task-1' })
    }
    expect(log).toHaveBeenCalledTimes(logCallsAfterCreated)
    controller.setTaskActive('main', false)

    expect(mocks.start).toHaveBeenCalledOnce()
    expect(mocks.stop).not.toHaveBeenCalled()

    controller.handleExecutorEvent('response.completed', { taskId: 'task-1' })
    expect(mocks.stop).toHaveBeenCalledWith(42)
  })

  test('ignores high-frequency response updates without logging or changing task activity', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const controller = new SystemSleepController()

    for (let index = 0; index < 2_200; index += 1) {
      controller.handleExecutorEvent('response.output_text.delta', { taskId: 'task-1' })
      controller.handleExecutorEvent('response.block.updated', { taskId: 'task-1' })
    }

    expect(log).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
  })
})
