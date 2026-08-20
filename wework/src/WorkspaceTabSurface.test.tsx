import { useEffect } from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceTabSurface } from './App'
import { getWorkbenchPluginRuntime } from '@/plugin-runtime/bootstrap'

const appIframeMocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
}))

vi.mock('@/components/topnav/AppIframe', () => ({
  AppIframe: ({ active }: { active?: boolean }) => {
    useEffect(() => appIframeMocks.cleanup, [])
    return <div data-testid="mock-app-iframe" data-active={String(active)} />
  },
}))

vi.mock('@/components/topnav/TitlebarActionsPortal', () => ({
  WorkspaceTabPortalOwner: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('WorkspaceTabSurface', () => {
  afterEach(() => {
    appIframeMocks.cleanup.mockClear()
  })

  test('keeps an inactive iframe app connected so its page state survives tab switches', () => {
    const dispose = getWorkbenchPluginRuntime().apps.register({
      key: 'harness-stateful',
      mode: 'iframe',
      url: 'http://localhost:3000',
      hidden: true,
      labelKey: 'harness-stateful.label',
      label: 'Stateful Harness',
      descriptionKey: 'harness-stateful.description',
      description: 'Stateful Harness',
    })
    const props = {
      cloudWebUrl: null,
      lifecycleStore: {} as never,
      services: {} as never,
      tab: {
        id: 'smart-app-1',
        kind: 'auxiliary' as const,
        title: 'Stateful Harness',
        contentRoute: '/app/harness-stateful',
      },
      user: {
        id: 1,
        user_name: 'tester',
        email: 'tester@example.com',
      },
    }

    const { rerender, unmount } = render(<WorkspaceTabSurface {...props} active />)
    expect(screen.getByTestId('mock-app-iframe')).toHaveAttribute('data-active', 'true')

    rerender(<WorkspaceTabSurface {...props} active={false} />)

    expect(screen.getByTestId('mock-app-iframe')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('workspace-tab-content-smart-app-1')).toHaveClass(
      'pointer-events-none',
      'invisible'
    )
    expect(appIframeMocks.cleanup).not.toHaveBeenCalled()

    unmount()
    expect(appIframeMocks.cleanup).toHaveBeenCalledTimes(1)
    dispose()
  })
})
