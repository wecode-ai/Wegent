import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DshClientContext } from '../dsh-runtime/DshClientContext'
import { AppearanceProvider } from './AppearanceProvider'
import { useAppearance } from './useAppearance'
import { clearStoredAppearance, mergeAppearance, writeStoredAppearance } from './storage'

function fixture(preference = 'system') {
  const listeners = new Set<() => void>()
  const theme = {
    getTheme: () => ({ preference }),
    setTheme: vi.fn((next: string) => {
      preference = next
      for (const listener of listeners) listener()
    }),
  }
  const context = {
    get: () => theme,
    on: (_event: string, listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as Context
  return { context, theme, listeners }
}

function Consumer() {
  const { setAppearance } = useAppearance()
  return (
    <>
      <input aria-label="Workbench draft" defaultValue="Keep this draft" />
      {(['light', 'dark', 'system'] as const).map(mode => (
        <button key={mode} data-testid={mode} onClick={() => setAppearance({ mode })}>
          {mode}
        </button>
      ))}
    </>
  )
}
function view(context: Context) {
  return (
    <DshClientContext.Provider value={context}>
      <AppearanceProvider persist={false}>
        <Consumer />
      </AppearanceProvider>
    </DshClientContext.Provider>
  )
}
function select(mode: 'light' | 'dark' | 'system') {
  fireEvent.click(screen.getByTestId(mode))
}
afterEach(() => {
  vi.restoreAllMocks()
  clearStoredAppearance()
})

it('synchronizes light, dark and system through the SDK without remounting the workbench', () => {
  const { context, theme, listeners } = fixture()
  writeStoredAppearance(mergeAppearance({ mode: 'light' }))
  const mounted = render(view(context))
  const input = screen.getByRole('textbox')
  select('dark')
  select('light')
  select('system')
  expect(screen.getByRole('textbox')).toBe(input)
  expect(input).toHaveValue('Keep this draft')
  expect(theme.setTheme.mock.calls.map(([mode]) => mode)).toEqual([
    'light',
    'dark',
    'light',
    'system',
  ])
  expect(listeners.size).toBe(1)
  mounted.unmount()
  expect(listeners.size).toBe(0)
})

it('reconciles a late SDK preference adoption without publishing a loop', () => {
  const { context, theme } = fixture('dark')
  writeStoredAppearance(mergeAppearance({ mode: 'dark' }))
  render(view(context))
  expect(theme.setTheme).not.toHaveBeenCalled()
  act(() => theme.setTheme('light'))
  expect(theme.getTheme().preference).toBe('dark')
  expect(theme.setTheme.mock.calls.map(([mode]) => mode)).toEqual(['light', 'dark'])
})

it('keeps the workbench available on a failed SDK write and recovers on a later change', () => {
  const { context, theme } = fixture('light')
  theme.setTheme.mockImplementationOnce(() => {
    throw new Error('Preference unavailable')
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  writeStoredAppearance(mergeAppearance({ mode: 'dark' }))
  render(view(context))
  expect(screen.getByRole('textbox')).toHaveValue('Keep this draft')
  expect(error).toHaveBeenCalled()
  select('system')
  expect(theme.getTheme().preference).toBe('system')
})
