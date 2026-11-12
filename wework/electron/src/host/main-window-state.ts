import type { BrowserWindow } from 'electron'
import type { PreferencesStore } from './preferences-store.js'
import { readMainWindowState, type MainWindowState } from './window-layout.js'

type StateWindow = Pick<
  BrowserWindow,
  | 'getNormalBounds'
  | 'isDestroyed'
  | 'isFullScreen'
  | 'isMaximized'
  | 'isMinimized'
  | 'on'
  | 'removeListener'
>

/** Tracks only the presented main window, never hidden startup or handoff geometry. */
export class MainWindowStateController {
  private window: StateWindow | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private state: MainWindowState | null = null

  constructor(
    private readonly store: Pick<PreferencesStore, 'update'>,
    private readonly onError: (error: unknown) => void
  ) {}

  start(window: StateWindow): void {
    if (this.window === window) return
    if (this.window) throw new Error('Main window state tracking is already active')
    this.window = window
    window.on('resize', this.changed)
    window.on('move', this.changed)
    window.on('maximize', this.changed)
    window.on('unmaximize', this.changed)
    window.on('restore', this.changed)
    window.on('leave-full-screen', this.changed)
    window.on('closed', this.closed)
    this.capture()
    this.changed()
  }

  async stop(): Promise<void> {
    this.capture()
    const window = this.window
    this.window = null
    if (window) {
      window.removeListener('resize', this.changed)
      window.removeListener('move', this.changed)
      window.removeListener('maximize', this.changed)
      window.removeListener('unmaximize', this.changed)
      window.removeListener('restore', this.changed)
      window.removeListener('leave-full-screen', this.changed)
      window.removeListener('closed', this.closed)
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.persist()
  }

  private readonly closed = () => {
    void this.stop().catch(this.onError)
  }

  private readonly changed = () => {
    this.capture()
    if (this.timer) clearTimeout(this.timer)
    // Coalesce native move/resize bursts and read after maximize transitions settle.
    this.timer = setTimeout(() => {
      this.timer = null
      this.capture()
      void this.persist().catch(this.onError)
    }, 250)
  }

  private capture(): void {
    const window = this.window
    // Minimize/full-screen frames are transient, not the user's normal window bounds.
    if (!window || window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
    const state = readMainWindowState({
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
    })
    if (state) this.state = state
  }

  private async persist(): Promise<void> {
    if (!this.state) return
    await this.store.update({ mainWindowState: this.state })
  }
}
