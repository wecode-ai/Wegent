import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { KeyboardShortcutsSettingsPage } from './KeyboardShortcutsSettingsPage'
import type { KeybindingOverride } from '@/lib/keybindings'

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), language: 'en' }))
vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: () => ({
    runtimeWorkApi: { getKeybindings: mocks.get, updateKeybindings: mocks.update },
  }),
}))
vi.mock('@/lib/keybindings', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/keybindings')>()),
  shortcutsAvailable: () => true,
}))
vi.mock('@/hooks/useTranslation', () => {
  const en = (key: string, fallback?: string) => fallback ?? key
  const zh = (key: string, fallback?: string) => fallback ?? key
  return { useTranslation: () => ({ t: mocks.language === 'en' ? en : zh }) }
})
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.language = 'en'
  mocks.get.mockResolvedValue({ keybindings: [] })
  mocks.update.mockImplementation(
    async ({ keybindings }: { keybindings: KeybindingOverride[] }) => ({ keybindings })
  )
})
async function mount() {
  const view = render(<KeyboardShortcutsSettingsPage />)
  await act(async () => {})
  return view
}

test('changing language does not reload keybindings', async () => {
  const view = await mount()
  mocks.language = 'zh'
  view.rerender(<KeyboardShortcutsSettingsPage />)
  await act(async () => {})
  expect(mocks.get).toHaveBeenCalledOnce()
})

test('serializes writes from different rows without losing a completed override', async () => {
  const first = held<{ keybindings: KeybindingOverride[] }>()
  mocks.update.mockReturnValueOnce(first.promise)
  await mount()
  fireEvent.click(screen.getByTestId('keyboard-shortcut-clear-openTerminal'))
  fireEvent.click(screen.getByTestId('keyboard-shortcut-clear-openSettings'))
  await act(async () => {})
  expect(mocks.update).toHaveBeenCalledTimes(1)
  await act(async () => first.resolve({ keybindings: [{ command: 'openTerminal', key: null }] }))
  expect(mocks.update).toHaveBeenLastCalledWith({
    keybindings: [
      { command: 'openTerminal', key: null },
      { command: 'openSettings', key: null },
    ],
  })
})

test('does not record a shortcut while an input method is composing', async () => {
  await mount()
  fireEvent.click(screen.getByTestId('keyboard-shortcut-record-openTerminal'))
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true, isComposing: true })
  await act(async () => {})
  expect(mocks.update).not.toHaveBeenCalled()
})

test('waits for existing overrides before applying an edit during the initial read', async () => {
  const initial = held<{ keybindings: KeybindingOverride[] }>()
  mocks.get.mockReturnValueOnce(initial.promise)
  await mount()
  fireEvent.click(screen.getByTestId('keyboard-shortcut-clear-openTerminal'))
  await act(async () => {})
  expect(mocks.update).not.toHaveBeenCalled()
  await act(async () =>
    initial.resolve({ keybindings: [{ command: 'openSettings', key: 'Control+U' }] })
  )
  expect(mocks.update).toHaveBeenCalledWith({
    keybindings: [
      { command: 'openSettings', key: 'Control+U' },
      { command: 'openTerminal', key: null },
    ],
  })
})

test('records a valid chord and cancels recording with Escape without saving', async () => {
  await mount()
  fireEvent.click(screen.getByTestId('keyboard-shortcut-record-openTerminal'))
  fireEvent.keyDown(window, { key: 'x', ctrlKey: true })
  await act(async () => {})
  expect(mocks.update).toHaveBeenLastCalledWith({
    keybindings: [{ command: 'openTerminal', key: 'Control+X' }],
  })
  expect(screen.getByTestId('keyboard-shortcut-record-openTerminal')).toHaveTextContent('X')
  fireEvent.click(screen.getByTestId('keyboard-shortcut-record-openSettings'))
  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
  await act(async () => {})
  expect(mocks.update).toHaveBeenCalledOnce()
})

test('detaches the recording listener on unmount', async () => {
  const view = await mount()
  fireEvent.click(screen.getByTestId('keyboard-shortcut-record-openTerminal'))
  view.unmount()
  fireEvent.keyDown(window, { key: 'x', ctrlKey: true })
  await act(async () => {})
  expect(mocks.update).not.toHaveBeenCalled()
})
