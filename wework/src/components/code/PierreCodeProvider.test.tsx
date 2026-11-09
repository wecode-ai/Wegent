import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import { PierreCodeProvider } from './PierreCodeProvider'
import { AppearanceContext } from '@/features/appearance/context'
import { defaultAppearance } from '@/features/appearance/presets'
import { WEWORK_CODE_THEME } from '@/lib/code-theme'

const pool = vi.hoisted(() => ({ setRenderOptions: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pierre/diffs/react', () => ({
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => children,
  useWorkerPool: () => pool,
}))

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
