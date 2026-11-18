import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PierreCodeProvider } from './PierreCodeProvider'
import { AppearanceContext } from '@/features/appearance/context'
import { defaultAppearance } from '@/features/appearance/presets'
import { WEWORK_CODE_THEME } from '@/lib/code-theme'

const pool = vi.hoisted(() => ({ setRenderOptions: vi.fn().mockResolvedValue(undefined) }))
const workerContext = vi.hoisted(() => ({ available: true }))
vi.mock('@pierre/diffs/react', () => ({
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => children,
  useWorkerPool: () => (workerContext.available ? pool : undefined),
}))

beforeEach(() => {
  workerContext.available = true
  pool.setRenderOptions.mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

test('updates the mounted worker pool when returning to Wework without remounting code content', async () => {
  const context = {
    appearance: { ...defaultAppearance, lightThemeId: 'github', darkThemeId: 'tokyo-night' },
    resolvedMode: 'dark' as const,
    setAppearance: vi.fn(),
    resetAppearance: vi.fn(),
  }
  const children = (
    <PierreCodeProvider>
      <input data-testid="code-draft" defaultValue="unsaved" />
    </PierreCodeProvider>
  )
  const { rerender } = render(
    <AppearanceContext.Provider value={context}>{children}</AppearanceContext.Provider>
  )
  await waitFor(() =>
    expect(pool.setRenderOptions).toHaveBeenLastCalledWith({ theme: WEWORK_CODE_THEME })
  )
  const draft = screen.getByTestId('code-draft')
  rerender(
    <AppearanceContext.Provider value={{ ...context, appearance: defaultAppearance }}>
      {children}
    </AppearanceContext.Provider>
  )
  await waitFor(() =>
    expect(pool.setRenderOptions).toHaveBeenLastCalledWith({
      theme: { light: 'pierre-light', dark: 'pierre-dark' },
    })
  )
  expect(screen.getByTestId('code-draft')).toBe(draft)
  expect(draft).toHaveValue('unsaved')
})

test('does not resynchronize the code pool for unrelated appearance changes', async () => {
  const context = {
    appearance: defaultAppearance,
    resolvedMode: 'light' as const,
    setAppearance: vi.fn(),
    resetAppearance: vi.fn(),
  }
  const view = (appearance: typeof defaultAppearance) => (
    <AppearanceContext.Provider value={{ ...context, appearance }}>
      <PierreCodeProvider>
        <input data-testid="same-theme-draft" defaultValue="keep" />
      </PierreCodeProvider>
    </AppearanceContext.Provider>
  )
  const { rerender } = render(view(defaultAppearance))
  await waitFor(() => expect(pool.setRenderOptions).toHaveBeenCalledOnce())
  const draft = screen.getByTestId('same-theme-draft')
  rerender(view({ ...defaultAppearance, uiFontSize: defaultAppearance.uiFontSize + 1 }))
  expect(pool.setRenderOptions).toHaveBeenCalledOnce()
  expect(screen.getByTestId('same-theme-draft')).toBe(draft)
})

test('retains mounted code content when the worker rejects a theme update', async () => {
  const cause = new Error('Highlighter unavailable')
  pool.setRenderOptions.mockRejectedValueOnce(cause)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  render(
    <PierreCodeProvider>
      <input data-testid="failed-theme-draft" defaultValue="unsaved" />
    </PierreCodeProvider>
  )
  await waitFor(() =>
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '[Wework] Failed to update the code theme:',
      cause
    )
  )
  expect(screen.getByTestId('failed-theme-draft')).toHaveValue('unsaved')
})

test('leaves code content available before a worker pool is present', () => {
  workerContext.available = false
  render(
    <PierreCodeProvider>
      <input data-testid="unavailable-pool-draft" defaultValue="unsaved" />
    </PierreCodeProvider>
  )
  expect(screen.getByTestId('unavailable-pool-draft')).toHaveValue('unsaved')
  expect(pool.setRenderOptions).not.toHaveBeenCalled()
})
