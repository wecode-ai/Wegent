import { EventEmitter } from 'node:events'
import type {
  WorkbenchRuntimeLaunch,
  WorkbenchRuntimeSnapshot,
} from '../runtime/workbench-runtime.js'

export interface WorkbenchViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WorkbenchTabView {
  load(url: string): Promise<void>
  setBounds(bounds: WorkbenchViewBounds): void
  evaluate(expression: string): Promise<unknown>
  capture(): Promise<string>
  close(): void
  onRendererGone(listener: (reason: string) => void): () => void
}

export interface WorkbenchRuntimeGateway {
  openWorkbenchRuntime(launch: WorkbenchRuntimeLaunch): Promise<WorkbenchRuntimeSnapshot>
  closeWorkbenchRuntime(tabId: string): Promise<void>
}

export interface WorkbenchTabSurface<View extends WorkbenchTabView> {
  bounds(): WorkbenchViewBounds
  show(view: View | null): void
}

export interface WorkbenchTabSnapshot extends WorkbenchRuntimeSnapshot {
  active: boolean
}

export interface WorkbenchTabControllerOptions<View extends WorkbenchTabView> {
  runtime: WorkbenchRuntimeGateway
  surface: WorkbenchTabSurface<View>
  createView(): View
}

interface WorkbenchTabEntry<View extends WorkbenchTabView> {
  runtime: WorkbenchRuntimeSnapshot
  view: View
  removeRendererGoneListener: () => void
}

/**
 * Owns the one-to-one relationship between a dynamic tab, its DSH process and
 * its Electron-native view.
 */
export class WorkbenchTabController<
  View extends WorkbenchTabView = WorkbenchTabView,
> extends EventEmitter {
  private readonly entries = new Map<string, WorkbenchTabEntry<View>>()
  private activeTabId: string | null = null
  private stopping = false

  constructor(private readonly options: WorkbenchTabControllerOptions<View>) {
    super()
  }

  list(): WorkbenchTabSnapshot[] {
    return [...this.entries.entries()].map(([tabId, entry]) => ({
      ...entry.runtime,
      active: tabId === this.activeTabId,
    }))
  }

  active(): string | null {
    return this.activeTabId
  }

  evaluate(tabId: string, expression: string): Promise<unknown> {
    return this.requiredEntry(tabId).view.evaluate(expression)
  }

  capture(tabId: string): Promise<string> {
    return this.requiredEntry(tabId).view.capture()
  }

  async open(launch: WorkbenchRuntimeLaunch, activate = true): Promise<WorkbenchTabSnapshot> {
    const existing = this.entries.get(launch.tabId)
    if (existing) {
      if (activate) this.activate(launch.tabId)
      return this.snapshot(launch.tabId, existing)
    }

    const runtime = await this.options.runtime.openWorkbenchRuntime(launch)
    const view = this.options.createView()
    const entry: WorkbenchTabEntry<View> = {
      runtime,
      view,
      removeRendererGoneListener: () => {},
    }
    entry.removeRendererGoneListener = view.onRendererGone(reason => {
      if (this.stopping || this.entries.get(launch.tabId) !== entry) return
      void this.close(launch.tabId, `renderer_gone:${reason}`)
    })
    this.entries.set(launch.tabId, entry)

    try {
      await view.load(runtime.url)
    } catch (error) {
      this.entries.delete(launch.tabId)
      entry.removeRendererGoneListener()
      view.close()
      await this.options.runtime.closeWorkbenchRuntime(launch.tabId)
      throw error
    }

    if (activate) this.activate(launch.tabId)
    this.emitChanged()
    return this.snapshot(launch.tabId, entry)
  }

  activate(tabId: string | null): void {
    if (tabId !== null && !this.entries.has(tabId)) {
      throw new Error(`Workbench tab is unavailable: ${tabId}`)
    }
    this.activeTabId = tabId
    const view = tabId === null ? null : (this.entries.get(tabId)?.view ?? null)
    this.options.surface.show(view)
    if (view) view.setBounds(this.options.surface.bounds())
    this.emitChanged()
  }

  layout(): void {
    if (!this.activeTabId) return
    this.entries.get(this.activeTabId)?.view.setBounds(this.options.surface.bounds())
  }

  async close(tabId: string, reason = 'closed'): Promise<void> {
    const entry = this.entries.get(tabId)
    if (!entry) return
    this.entries.delete(tabId)
    entry.removeRendererGoneListener()
    if (this.activeTabId === tabId) {
      this.activeTabId = null
      this.options.surface.show(null)
    }
    entry.view.close()
    await this.options.runtime.closeWorkbenchRuntime(tabId)
    this.emit('closed', { tabId, reason })
    this.emitChanged()
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.activeTabId = null
    this.options.surface.show(null)
    const entries = [...this.entries.entries()]
    this.entries.clear()
    for (const [, entry] of entries) {
      entry.removeRendererGoneListener()
      entry.view.close()
    }
    await Promise.allSettled(
      entries.map(([tabId]) => this.options.runtime.closeWorkbenchRuntime(tabId))
    )
    this.emitChanged()
  }

  private snapshot(tabId: string, entry: WorkbenchTabEntry<View>): WorkbenchTabSnapshot {
    return {
      ...entry.runtime,
      active: tabId === this.activeTabId,
    }
  }

  private requiredEntry(tabId: string): WorkbenchTabEntry<View> {
    const entry = this.entries.get(tabId)
    if (!entry) throw new Error(`Workbench tab is unavailable: ${tabId}`)
    return entry
  }

  private emitChanged(): void {
    this.emit('change', this.list())
  }
}
