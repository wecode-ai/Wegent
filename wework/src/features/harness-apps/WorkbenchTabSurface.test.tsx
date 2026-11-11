import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchTabSurface } from './WorkbenchTabSurface'

const mocks = vi.hoisted(() => ({ layout: vi.fn() }))
vi.mock('@/api/local/harnessApps', () => ({ harnessAppsApi: { layout: mocks.layout } }))
const t = (_key: string, fallback: string) => fallback
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))

describe('WorkbenchTabSurface', () => {
  let resize: () => void
  const props = { installationId: 'calculator', title: 'Calculator', workspaceTabId: 'tab-1' }
  const bounds = { x: 30, y: 42, width: 800, height: 600 }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.layout.mockResolvedValue(undefined)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      ...bounds,
      left: 30,
      top: 42,
      right: 830,
      bottom: 642,
    } as DOMRect)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback
        }
        observe() {}
        disconnect() {}
      }
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('reports geometry for one Host surface and never embeds a second page', async () => {
    const view = render(<WorkbenchTabSurface {...props} active />)
    await waitFor(() => expect(mocks.layout).toHaveBeenLastCalledWith('calculator', bounds, true))
    expect(screen.getByTestId('app-iframe-harness-calculator')).toHaveAttribute(
      'data-workspace-tab-id',
      'tab-1'
    )
    expect(view.container.querySelector('iframe, webview')).toBeNull()
    view.rerender(<WorkbenchTabSurface {...props} active={false} />)
    await waitFor(() => expect(mocks.layout).toHaveBeenLastCalledWith('calculator', bounds, false))
    view.unmount()
    await waitFor(() =>
      expect(mocks.layout).toHaveBeenLastCalledWith(
        'calculator',
        { x: 0, y: 0, width: 0, height: 0 },
        false
      )
    )
  })

  test('keeps requests ordered when an old layout is still pending', async () => {
    let finish: () => void = () => {}
    mocks.layout.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const view = render(<WorkbenchTabSurface {...props} active />)
    await waitFor(() => expect(mocks.layout).toHaveBeenCalledTimes(1))
    view.rerender(<WorkbenchTabSurface {...props} active={false} />)
    expect(mocks.layout).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    await waitFor(() => expect(mocks.layout).toHaveBeenLastCalledWith('calculator', bounds, false))
  })

  test('hides the native surface behind a visible dialog and restores it after closing', async () => {
    const view = render(<WorkbenchTabSurface {...props} active />)
    await waitFor(() => expect(mocks.layout).toHaveBeenLastCalledWith('calculator', bounds, true))
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    await act(async () => document.body.append(dialog))
    await waitFor(() => expect(mocks.layout).toHaveBeenLastCalledWith('calculator', bounds, false))
    await act(async () => dialog.remove())
    await waitFor(() => expect(mocks.layout).toHaveBeenLastCalledWith('calculator', bounds, true))
    view.unmount()
  })

  test('retries a failed attachment and observes later geometry updates', async () => {
    mocks.layout.mockRejectedValueOnce(new Error('attachment failed'))
    render(<WorkbenchTabSurface {...props} active />)
    expect(await screen.findByRole('alert')).toHaveTextContent('无法显示工作台，请重试。')
    fireEvent.click(screen.getByTestId('workbench-layout-retry'))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    mocks.layout.mockClear()
    act(() => resize())
    await waitFor(() => expect(mocks.layout).toHaveBeenCalledWith('calculator', bounds, true))
  })
})
