import { beforeEach, describe, expect, test, vi } from 'vitest'

const emitToMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
const getCurrentWindowMock = vi.hoisted(() => vi.fn())
const isTauriRuntimeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: emitToMock,
  listen: listenMock,
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: getCurrentWindowMock,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: isTauriRuntimeMock,
}))

describe('runtimeWorkSync', () => {
  beforeEach(() => {
    vi.resetModules()
    emitToMock.mockReset()
    listenMock.mockReset()
    getCurrentWindowMock.mockReset()
    isTauriRuntimeMock.mockReset()
  })

  test('notifies the main window when a secondary window changes runtime work', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    getCurrentWindowMock.mockReturnValue({ label: 'popout-window' })
    emitToMock.mockResolvedValue(undefined)

    const { notifyMainRuntimeWorkChanged, RUNTIME_WORK_CHANGED_EVENT } =
      await import('./runtimeWorkSync')

    await notifyMainRuntimeWorkChanged({
      deviceId: 'local-device',
      taskId: 'task-1',
    })

    expect(emitToMock).toHaveBeenCalledWith('main', RUNTIME_WORK_CHANGED_EVENT, {
      deviceId: 'local-device',
      taskId: 'task-1',
    })
  })

  test('does not notify when the change already originates from the main window', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    getCurrentWindowMock.mockReturnValue({ label: 'main' })

    const { notifyMainRuntimeWorkChanged } = await import('./runtimeWorkSync')

    await notifyMainRuntimeWorkChanged({
      deviceId: 'local-device',
      taskId: 'task-1',
    })

    expect(emitToMock).not.toHaveBeenCalled()
  })

  test('refreshes runtime work when the main window receives the event', async () => {
    let eventHandler: ((event: { payload: { deviceId: string; taskId: string } }) => void) | null =
      null
    isTauriRuntimeMock.mockReturnValue(true)
    getCurrentWindowMock.mockReturnValue({ label: 'main' })
    listenMock.mockImplementation((_eventName: string, handler: typeof eventHandler) => {
      eventHandler = handler
      return Promise.resolve(vi.fn())
    })
    const refreshRuntimeWork = vi.fn().mockResolvedValue(undefined)

    const { installMainRuntimeWorkChangedListener, RUNTIME_WORK_CHANGED_EVENT } =
      await import('./runtimeWorkSync')

    installMainRuntimeWorkChangedListener(refreshRuntimeWork)

    expect(listenMock).toHaveBeenCalledWith(RUNTIME_WORK_CHANGED_EVENT, expect.any(Function))
    eventHandler?.({
      payload: {
        deviceId: 'local-device',
        taskId: 'task-1',
      },
    })
    await vi.waitFor(() => expect(refreshRuntimeWork).toHaveBeenCalledOnce())
  })

  test('does not install the refresh listener in a secondary window', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    getCurrentWindowMock.mockReturnValue({ label: 'popout-window' })

    const { installMainRuntimeWorkChangedListener } = await import('./runtimeWorkSync')

    expect(installMainRuntimeWorkChangedListener(vi.fn())).toBeNull()
    expect(listenMock).not.toHaveBeenCalled()
  })
})
