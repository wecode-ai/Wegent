import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserWindowConstructorOptions } from 'electron'

export type StartupSplashEventName = 'created' | 'shown' | 'animation-ready' | 'closed'

export interface StartupSplashEvent {
  name: StartupSplashEventName
  timestamp: number
}

export interface StartupSplashSnapshot {
  state: 'idle' | 'loading' | 'visible' | 'closed'
  events: StartupSplashEvent[]
  window: {
    exists: boolean
    destroyed: boolean
    visible: boolean
  }
}

interface SplashImage {
  toPNG: () => Buffer
}

interface SplashWebContents {
  capturePage: () => Promise<SplashImage>
  executeJavaScript: (code: string) => Promise<unknown>
  isDestroyed: () => boolean
}

export interface StartupSplashWindow {
  close: () => void
  isDestroyed: () => boolean
  isVisible: () => boolean
  loadFile: (path: string) => Promise<void>
  once: (event: 'closed' | 'ready-to-show', listener: () => void) => void
  show: () => void
  webContents: SplashWebContents
}

export interface StartupSplashOptions {
  createWindow: (options: BrowserWindowConstructorOptions) => StartupSplashWindow
  htmlPath: string
  now?: () => number
  writePng?: (path: string, bytes: Buffer) => Promise<void>
}

export interface CloseStartupSplashOptions {
  capturePath?: string
}

const WAIT_FOR_ANIMATION_READY = `
  new Promise((resolve) => {
    const wait = () => {
      if (document.documentElement.dataset.animationReady === 'true') {
        resolve(true)
        return
      }
      requestAnimationFrame(wait)
    }
    wait()
  })
`

const WINDOW_OPTIONS: Readonly<BrowserWindowConstructorOptions> = {
  width: 420,
  height: 260,
  show: false,
  frame: false,
  transparent: true,
  resizable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  movable: false,
  center: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  hasShadow: true,
  backgroundColor: '#00000000',
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
}

async function writePng(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

export class StartupSplash {
  private readonly events: StartupSplashEvent[] = []
  private readonly now: () => number
  private readonly persistPng: (path: string, bytes: Buffer) => Promise<void>
  private window: StartupSplashWindow | null = null
  private state: StartupSplashSnapshot['state'] = 'idle'
  private showPromise: Promise<StartupSplashSnapshot> | null = null

  constructor(private readonly options: StartupSplashOptions) {
    this.now = options.now ?? Date.now
    this.persistPng = options.writePng ?? writePng
  }

  show(): Promise<StartupSplashSnapshot> {
    if (this.showPromise) return this.showPromise
    if (this.state === 'closed') {
      return Promise.reject(new Error('Startup splash cannot be shown after it is closed'))
    }

    this.showPromise = this.createAndShow()
    return this.showPromise
  }

  async close(options: CloseStartupSplashOptions = {}): Promise<StartupSplashSnapshot> {
    const target = this.window
    if (!target || target.isDestroyed()) {
      this.markClosed()
      return this.snapshot()
    }

    try {
      if (options.capturePath) {
        const image = await target.webContents.capturePage()
        await this.persistPng(options.capturePath, image.toPNG())
      }
    } finally {
      if (!target.isDestroyed()) target.close()
      this.markClosed()
    }

    return this.snapshot()
  }

  snapshot(): StartupSplashSnapshot {
    const target = this.window
    const destroyed = target?.isDestroyed() ?? false
    return {
      state: this.state,
      events: this.events.map(event => ({ ...event })),
      window: {
        exists: target !== null,
        destroyed,
        visible: target !== null && !destroyed && target.isVisible(),
      },
    }
  }

  private async createAndShow(): Promise<StartupSplashSnapshot> {
    this.state = 'loading'
    const target = this.options.createWindow({ ...WINDOW_OPTIONS })
    this.window = target
    this.record('created')

    const shown = new Promise<void>(resolve => {
      target.once('ready-to-show', () => {
        if (!target.isDestroyed()) {
          target.show()
          this.state = 'visible'
          this.record('shown')
        }
        resolve()
      })
    })
    target.once('closed', () => this.markClosed())

    await target.loadFile(this.options.htmlPath)
    await shown
    if (!target.webContents.isDestroyed()) {
      await target.webContents.executeJavaScript(WAIT_FOR_ANIMATION_READY)
      this.record('animation-ready')
    }
    return this.snapshot()
  }

  private markClosed(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.record('closed')
  }

  private record(name: StartupSplashEventName): void {
    this.events.push({ name, timestamp: this.now() })
  }
}

export function createStartupSplash(options: StartupSplashOptions): StartupSplash {
  return new StartupSplash(options)
}
