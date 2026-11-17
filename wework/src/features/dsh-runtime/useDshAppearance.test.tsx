import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DshClientContext } from './DshClientContext'
import { useDshAppearance } from './useDshAppearance'

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

function Consumer({ mode }: { mode: 'light' | 'dark' | 'system' }) {
  useDshAppearance(mode)
  return <input aria-label="Workbench draft" defaultValue="Keep this draft" />
}

afterEach(() => vi.restoreAllMocks())

it('synchronizes light, dark and system through the SDK without remounting the workbench', () => {
  const { context, theme, listeners } = fixture()
  const view = (mode: 'light' | 'dark' | 'system') => (
    <DshClientContext.Provider value={context}>
      <Consumer mode={mode} />
    </DshClientContext.Provider>
  )
  const mounted = render(view('light'))
  const input = screen.getByRole('textbox')
  mounted.rerender(view('dark'))
  mounted.rerender(view('light'))
  mounted.rerender(view('system'))
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
  render(
    <DshClientContext.Provider value={context}>
      <Consumer mode="dark" />
    </DshClientContext.Provider>
  )
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
  const view = (mode: 'dark' | 'system') => (
    <DshClientContext.Provider value={context}>
      <Consumer mode={mode} />
    </DshClientContext.Provider>
  )
  const mounted = render(view('dark'))
  expect(screen.getByRole('textbox')).toHaveValue('Keep this draft')
  expect(error).toHaveBeenCalled()
  mounted.rerender(view('system'))
  expect(theme.getTheme().preference).toBe('system')
})
