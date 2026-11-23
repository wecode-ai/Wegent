import { expect, test, vi } from 'vitest'
import { createKeyboardShortcutsResource } from './keyboardShortcutsResource'
import type { KeybindingOverride } from '@/lib/keybindings'
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function api() {
  return {
    getKeybindings: vi.fn(async () => ({ keybindings: [] as KeybindingOverride[] })),
    updateKeybindings: vi.fn(async (input: { keybindings: KeybindingOverride[] }) => input),
  }
}

test('finishes accepted queued writes after detaching and notifies every committed change', async () => {
  const service = api()
  const changed = vi.fn()
  const firstResponse = held<{ keybindings: KeybindingOverride[] }>()
  const firstStarted = held<void>()
  service.updateKeybindings.mockImplementationOnce(() => {
    firstStarted.resolve()
    return firstResponse.promise
  })
  const resource = createKeyboardShortcutsResource(() => service, true, changed)
  const stop = resource.subscribe(vi.fn())
  const first = resource.save('openTerminal', null)
  const second = resource.save('openSettings', null)
  await firstStarted.promise
  stop()
  expect(changed).not.toHaveBeenCalled()
  firstResponse.resolve({ keybindings: [{ command: 'openTerminal', key: null }] })
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  expect(service.updateKeybindings).toHaveBeenLastCalledWith({
    keybindings: [
      { command: 'openTerminal', key: null },
      { command: 'openSettings', key: null },
    ],
  })
  expect(resource.getSnapshot().saving.size).toBe(0)
  expect(changed).toHaveBeenCalledTimes(2)
})

test('continues the queue after a failed edit without using the uncommitted override', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const service = api()
    service.updateKeybindings.mockRejectedValueOnce(new Error('offline'))
    const resource = createKeyboardShortcutsResource(() => service, true, vi.fn())
    const stop = resource.subscribe(vi.fn())
    const first = resource.save('openTerminal', null)
    const second = resource.save('openSettings', null)
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(service.updateKeybindings).toHaveBeenLastCalledWith({
      keybindings: [{ command: 'openSettings', key: null }],
    })
    expect(resource.getSnapshot().error).toBeUndefined()
    stop()
  } finally {
    log.mockRestore()
  }
})

test('does not replace unknown configuration after a failed read and can recover on a new edit', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const service = api()
    service.getKeybindings
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ keybindings: [{ command: 'openSettings', key: 'Control+U' }] })
    const resource = createKeyboardShortcutsResource(() => service, true, vi.fn())
    const stop = resource.subscribe(vi.fn())
    expect(await resource.save('openTerminal', null)).toBe(false)
    expect(service.updateKeybindings).not.toHaveBeenCalled()
    expect(await resource.save('openTerminal', null)).toBe(true)
    expect(service.updateKeybindings).toHaveBeenCalledWith({
      keybindings: [
        { command: 'openSettings', key: 'Control+U' },
        { command: 'openTerminal', key: null },
      ],
    })
    stop()
  } finally {
    log.mockRestore()
  }
})

test('preserves unrelated overrides for commands outside the built-in settings list', async () => {
  const service = api()
  service.getKeybindings.mockResolvedValue({
    keybindings: [{ command: 'extension.command', key: null }],
  })
  const resource = createKeyboardShortcutsResource(() => service, true, vi.fn())
  const stop = resource.subscribe(vi.fn())
  expect(await resource.save('openTerminal', null)).toBe(true)
  expect(service.updateKeybindings).toHaveBeenCalledWith({
    keybindings: [
      { command: 'extension.command', key: null },
      { command: 'openTerminal', key: null },
    ],
  })
  stop()
})
