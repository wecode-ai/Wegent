import { beforeEach, describe, expect, test, vi } from 'vitest'
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

    controller.handleExecutorEvent('response.created', { taskId: 'task-1' })
    controller.setTaskActive('main', false)

    expect(mocks.start).toHaveBeenCalledOnce()
    expect(mocks.stop).not.toHaveBeenCalled()

    controller.handleExecutorEvent('response.completed', { taskId: 'task-1' })
    expect(mocks.stop).toHaveBeenCalledWith(42)
  })
})
