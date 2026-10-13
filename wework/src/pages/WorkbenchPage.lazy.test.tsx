import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchPage } from './WorkbenchPage'

const runtime = vi.hoisted(() => ({ electron: true, mobile: true }))
const loadMobile = vi.hoisted(() => vi.fn())

vi.mock('@/components/layout/DesktopWorkbenchLayout', () => ({
  DesktopWorkbenchLayout: ({ surfaceKind }: { surfaceKind?: string }) => (
    <div data-testid="desktop-layout" data-surface-kind={surfaceKind} />
  ),
}))
vi.mock('@/components/layout/MobileWorkbenchLayout', () => {
  loadMobile()
  return { MobileWorkbenchLayout: () => <div data-testid="mobile-layout" /> }
})
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => runtime.electron }))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => runtime.mobile }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ state: { runtimeWork: null } }),
}))
vi.mock('@/features/workbench/runtimeTaskLifecycle', () => ({
  useRuntimeTaskLifecycleStoreSnapshot: () => ({}),
}))
vi.mock('@/features/workbench/useRuntimeTaskRouteRestoration', () => ({
  useRuntimeTaskRouteRestoration: () => {},
}))
vi.mock('@/desktop/trayMenuState', () => ({ buildTrayMenuTaskGroups: () => ({}) }))
vi.mock('@/desktop/trayNavigation', () => ({ syncTrayMenuState: () => {} }))
vi.mock('@/features/system-drag/SystemDragBridge', () => ({ SystemDragBridge: () => null }))

describe('WorkbenchPage optional mobile module', () => {
  beforeEach(() => {
    runtime.electron = true
    runtime.mobile = true
  })

  test('does not import the mobile layout in a narrow Electron task window', () => {
    render(<WorkbenchPage surfaceKind="task" />)
    expect(screen.getByTestId('desktop-layout')).toHaveAttribute('data-surface-kind', 'task')
    expect(loadMobile).not.toHaveBeenCalled()
  })

  test('keeps the board layout on desktop without importing mobile in a narrow browser', () => {
    runtime.electron = false
    render(<WorkbenchPage surfaceKind="board" />)
    expect(screen.getByTestId('desktop-layout')).toHaveAttribute('data-surface-kind', 'board')
    expect(loadMobile).not.toHaveBeenCalled()
  })

  test('loads the mobile layout when a narrow browser actually renders the task surface', async () => {
    runtime.electron = false
    render(<WorkbenchPage surfaceKind="task" />)
    expect(await screen.findByTestId('mobile-layout')).toBeInTheDocument()
    expect(loadMobile).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('desktop-layout')).not.toBeInTheDocument()
  })
})
