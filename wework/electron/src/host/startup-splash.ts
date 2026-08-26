import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type StartupSplashEventName = 'created' | 'shown' | 'animation-ready' | 'closed'
export type StartupSplashTheme = 'light' | 'dark'

export interface StartupSplashEvent {
  name: StartupSplashEventName
  timestamp: number
}

export interface StartupSplashSnapshot {
  state: 'idle' | 'loading' | 'visible' | 'closed'
  theme: StartupSplashTheme
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
  isDestroyed: () => boolean
  isVisible: () => boolean
  once: (event: 'closed' | 'ready-to-show', listener: () => void) => void
  show: () => void
  webContents: SplashWebContents
}

export interface StartupSplashOptions {
  window: StartupSplashWindow
  theme: StartupSplashTheme
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

export function resolveStartupSplashTheme(
  appearanceMode: unknown,
  systemUsesDarkColors: boolean
): StartupSplashTheme {
  if (appearanceMode === 'light' || appearanceMode === 'dark') return appearanceMode
  return systemUsesDarkColors ? 'dark' : 'light'
}

async function writePng(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

export class StartupSplash {
  private readonly events: StartupSplashEvent[] = []
  private readonly now: () => number
  private readonly persistPng: (path: string, bytes: Buffer) => Promise<void>
  private state: StartupSplashSnapshot['state'] = 'idle'
  private showPromise: Promise<StartupSplashSnapshot> | null = null

  constructor(private readonly options: StartupSplashOptions) {
    this.now = options.now ?? Date.now
    this.persistPng = options.writePng ?? writePng
    this.record('created')
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
    const target = this.options.window
    if (target.isDestroyed()) {
      this.markClosed()
      return this.snapshot()
    }

    try {
      if (options.capturePath) {
        const image = await target.webContents.capturePage()
        await this.persistPng(options.capturePath, image.toPNG())
      }
    } finally {
      this.markClosed()
    }

    return this.snapshot()
  }

  snapshot(): StartupSplashSnapshot {
    const target = this.options.window
    const destroyed = target.isDestroyed()
    return {
      state: this.state,
      theme: this.options.theme,
      events: this.events.map(event => ({ ...event })),
      window: {
        exists: true,
        destroyed,
        visible: !destroyed && target.isVisible(),
      },
    }
  }

  private async createAndShow(): Promise<StartupSplashSnapshot> {
    this.state = 'loading'
    const target = this.options.window

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
