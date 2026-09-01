import { describe, expect, test, vi } from 'vitest'
import {
  GlobalShortcutController,
  type GlobalShortcutRegistry,
} from './global-shortcut-controller.js'

function createController() {
  const callbacks = new Map<string, () => void>()
  const registry = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      callbacks.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator: string) => {
      callbacks.delete(accelerator)
    }),
  } satisfies GlobalShortcutRegistry
  const action = vi.fn(async () => undefined)
  const reportError = vi.fn()
  const controller = new GlobalShortcutController(registry, action, reportError)
  return { action, callbacks, controller, registry, reportError }
}

describe('GlobalShortcutController', () => {
  test('registers a shortcut and invokes its action', async () => {
    const { action, callbacks, controller, registry } = createController()

    controller.configure('Alt+Shift+Z')
    callbacks.get('Alt+Shift+Z')?.()
    await Promise.resolve()

    expect(registry.register).toHaveBeenCalledWith('Alt+Shift+Z', expect.any(Function))
    expect(action).toHaveBeenCalledOnce()
  })

  test('replaces the old shortcut only after the new one registers', () => {
    const { controller, registry } = createController()

    controller.configure('Alt+Shift+Space')
    controller.configure('Alt+Shift+Z')

    expect(registry.unregister).toHaveBeenCalledWith('Alt+Shift+Space')
  })

  test('keeps the old shortcut when replacement registration fails', () => {
    const { callbacks, controller, registry } = createController()
    controller.configure('Alt+Shift+Space')
    registry.register.mockReturnValueOnce(false)

    expect(() => controller.configure('Alt+Shift+Z')).toThrow(
      'Global shortcut is unavailable: Alt+Shift+Z'
    )
    expect(callbacks.has('Alt+Shift+Space')).toBe(true)
    expect(registry.unregister).not.toHaveBeenCalled()
  })

  test('unregisters the shortcut when cleared or disposed', () => {
    const { controller, registry } = createController()

    controller.configure('Alt+Shift+Z')
    controller.configure(null)
    controller.configure('Alt+Shift+Space')
    controller.dispose()

    expect(registry.unregister).toHaveBeenNthCalledWith(1, 'Alt+Shift+Z')
    expect(registry.unregister).toHaveBeenNthCalledWith(2, 'Alt+Shift+Space')
  })

  test('reports asynchronous action failures', async () => {
    const { callbacks, controller, reportError } = createController()
    const error = new Error('show failed')
    const failingController = new GlobalShortcutController(
      {
        register: (accelerator, callback) => {
          callbacks.set(accelerator, callback)
          return true
        },
        unregister: vi.fn(),
      },
      () => Promise.reject(error),
      reportError
    )

    failingController.configure('Alt+Shift+Z')
    callbacks.get('Alt+Shift+Z')?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(reportError).toHaveBeenCalledWith(error)
    controller.dispose()
  })
})
