import { describe, expect, test, vi } from 'vitest'
import type { WorkbenchRuntimeLaunch } from '../runtime/workbench-runtime.js'
import { WorkbenchTabController, type WorkbenchTabView } from './workbench-tab-controller.js'

class FakeView implements WorkbenchTabView {
  readonly load = vi.fn(async () => {})
  readonly setBounds = vi.fn(() => {})
  readonly evaluate = vi.fn(async () => null)
  readonly capture = vi.fn(async () => 'data:image/png;base64,fixture')
  readonly close = vi.fn(() => {})
  private rendererGone: ((reason: string) => void) | null = null

  onRendererGone(listener: (reason: string) => void): () => void {
    this.rendererGone = listener
    return () => {
      if (this.rendererGone === listener) this.rendererGone = null
    }
  }

  crash(reason = 'crashed'): void {
    this.rendererGone?.(reason)
  }
}

function launch(tabId: string, port: number): WorkbenchRuntimeLaunch {
  return {
    tabId,
    url: `http://127.0.0.1:${port}`,
    command: '/runtime/dsh',
  }
}

describe('WorkbenchTabController', () => {
  test('owns one process and one native view per tab', async () => {
    const views: FakeView[] = []
    const shown: Array<FakeView | null> = []
    const runtime = {
      openWorkbenchRuntime: vi.fn(async (input: WorkbenchRuntimeLaunch) => ({
        tabId: input.tabId,
        url: input.url,
        pid: input.tabId.endsWith('one') ? 101 : 102,
      })),
      closeWorkbenchRuntime: vi.fn(async () => {}),
    }
    const controller = new WorkbenchTabController({
      runtime,
      surface: {
        bounds: () => ({ x: 0, y: 48, width: 1200, height: 752 }),
        show: view => shown.push(view),
      },
      createView: () => {
        const view = new FakeView()
        views.push(view)
        return view
      },
    })

    await controller.open(launch('smart-app:one', 4101))
    await controller.open(launch('smart-app:two', 4102), false)

    expect(runtime.openWorkbenchRuntime).toHaveBeenCalledTimes(2)
    expect(views).toHaveLength(2)
    expect(views[0].load).toHaveBeenCalledWith('http://127.0.0.1:4101')
    expect(controller.list()).toEqual([
      {
        tabId: 'smart-app:one',
        url: 'http://127.0.0.1:4101',
        pid: 101,
        active: true,
      },
      {
        tabId: 'smart-app:two',
        url: 'http://127.0.0.1:4102',
        pid: 102,
        active: false,
      },
    ])
    await expect(controller.evaluate('smart-app:one', 'document.title')).resolves.toBeNull()
    await expect(controller.capture('smart-app:one')).resolves.toBe('data:image/png;base64,fixture')
    expect(views[0].evaluate).toHaveBeenCalledWith('document.title')
    expect(views[0].capture).toHaveBeenCalledOnce()
    expect(shown.at(-1)).toBe(views[0])
  })

  test('switches back to the core surface and closes only the selected tab', async () => {
    const views: FakeView[] = []
    const show = vi.fn()
    const runtime = {
      openWorkbenchRuntime: vi.fn(async (input: WorkbenchRuntimeLaunch) => ({
        tabId: input.tabId,
        url: input.url,
        pid: 201,
      })),
      closeWorkbenchRuntime: vi.fn(async () => {}),
    }
    const controller = new WorkbenchTabController({
      runtime,
      surface: {
        bounds: () => ({ x: 0, y: 48, width: 900, height: 552 }),
        show,
      },
      createView: () => {
        const view = new FakeView()
        views.push(view)
        return view
      },
    })

    await controller.open(launch('smart-app:review', 4201))
    await controller.close('smart-app:review')

    expect(show).toHaveBeenLastCalledWith(null)
    expect(views[0].close).toHaveBeenCalledOnce()
    expect(runtime.closeWorkbenchRuntime).toHaveBeenCalledWith('smart-app:review')
    expect(controller.active()).toBeNull()
  })

  test('cleans up the process when its renderer crashes', async () => {
    const view = new FakeView()
    const runtime = {
      openWorkbenchRuntime: vi.fn(async (input: WorkbenchRuntimeLaunch) => ({
        tabId: input.tabId,
        url: input.url,
        pid: 301,
      })),
      closeWorkbenchRuntime: vi.fn(async () => {}),
    }
    const controller = new WorkbenchTabController({
      runtime,
      surface: {
        bounds: () => ({ x: 0, y: 48, width: 900, height: 552 }),
        show: vi.fn(),
      },
      createView: () => view,
    })

    await controller.open(launch('smart-app:crash', 4301))
    view.crash('oom')
    await vi.waitFor(() =>
      expect(runtime.closeWorkbenchRuntime).toHaveBeenCalledWith('smart-app:crash')
    )

    expect(view.close).toHaveBeenCalledOnce()
    expect(controller.list()).toEqual([])
  })

  test('rolls back both resources when the view cannot load', async () => {
    const view = new FakeView()
    view.load.mockRejectedValueOnce(new Error('load failed'))
    const runtime = {
      openWorkbenchRuntime: vi.fn(async (input: WorkbenchRuntimeLaunch) => ({
        tabId: input.tabId,
        url: input.url,
        pid: 401,
      })),
      closeWorkbenchRuntime: vi.fn(async () => {}),
    }
    const controller = new WorkbenchTabController({
      runtime,
      surface: {
        bounds: () => ({ x: 0, y: 48, width: 900, height: 552 }),
        show: vi.fn(),
      },
      createView: () => view,
    })

    await expect(controller.open(launch('smart-app:broken', 4401))).rejects.toThrow('load failed')
    expect(view.close).toHaveBeenCalledOnce()
    expect(runtime.closeWorkbenchRuntime).toHaveBeenCalledWith('smart-app:broken')
    expect(controller.list()).toEqual([])
  })
})
