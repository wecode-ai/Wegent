import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { STARTUP_PROGRESS_CHANNEL, type StartupProgressUpdate } from './startup-progress.js'
import type { StartupWindowBounds } from './startup-window-handoff.js'
import { finishStartupAnimation } from './startup-tasks.js'

export type StartupSplashEventName =
  | 'created'
  | 'shown'
  | 'animation-ready'
  | 'completion-started'
  | 'completed'
  | 'main-prepared'
  | 'fade-started'
  | 'fade-completed'
  | 'closed'
export type StartupSplashTheme = 'light' | 'dark'

export interface StartupSplashEvent {
  name: StartupSplashEventName
  timestamp: number
}

export interface StartupSplashSnapshot {
  state: 'idle' | 'loading' | 'visible' | 'completing' | 'fading' | 'closed'
  theme: StartupSplashTheme
  events: StartupSplashEvent[]
  handoff?: {
    fadeDurationMs: number
    reducedMotion: boolean
    completion: StartupSplashCompletion
    bounds: StartupWindowBounds
  }
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
  send: (channel: string, payload: unknown) => void
}

export interface StartupSplashWindow {
  close: () => void
  isDestroyed: () => boolean
  isVisible: () => boolean
  on: (event: 'close', listener: (event: StartupSplashCloseEvent) => void) => void
  once: (event: 'closed', listener: () => void) => void
  show: () => void | Promise<void>
  setOpacity: (opacity: number) => void
  webContents: SplashWebContents
}

export interface StartupSplashCloseEvent {
  preventDefault: () => void
}

export interface StartupSplashOptions {
  window: StartupSplashWindow
  theme: StartupSplashTheme
  now?: () => number
  writePng?: (path: string, bytes: Buffer) => Promise<void>
  /**
   * Notified after a user-initiated close request is refused. The splash is the
   * only visible window during startup, so the host decides what closing it means.
   */
  onCloseRequest?: () => void
}

export interface CloseStartupSplashOptions {
  capturePath?: string
}

export interface StartupSplashCompletion {
  reducedMotion: boolean
  progressNow: number
  fillEnd: number
  trackEnd: number
  wordmarkVisible: boolean
  appearance: {
    theme: StartupSplashTheme
    colorScheme: string
    background: string
    footerBackground: string
  }
  canvas: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
}

export interface StartupSplashHandoffOptions extends CloseStartupSplashOptions {
  update: StartupProgressUpdate
  prepareMainWindow: () => Promise<StartupWindowBounds>
  shouldContinue: () => boolean
}

export const STARTUP_SPLASH_FADE_MS = 600

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

const MAX_STARTUP_SPLASH_HOLD_MS = 120_000
export const STARTUP_SPLASH_HOLD_ENV = 'WEWORK_E2E_STARTUP_SPLASH_HOLD_MS'

/**
 * The desktop E2E harness can hold the splash on screen after the workbench
 * reports readiness, so window-lifecycle checks can act on splash-only behavior
 * instead of racing the splash teardown. Outside the harness this is always 0.
 */
export function resolveStartupSplashHoldMs(environment: NodeJS.ProcessEnv): number {
  if (environment.VITE_WEWORK_E2E !== 'true') return 0
  const holdMs = Number(environment[STARTUP_SPLASH_HOLD_ENV])
  if (!Number.isFinite(holdMs) || holdMs <= 0) return 0
  return Math.min(Math.trunc(holdMs), MAX_STARTUP_SPLASH_HOLD_MS)
}

export function startupSplashBlocksMainWindowActivation(
  snapshot: StartupSplashSnapshot | null
): boolean {
  return snapshot !== null && snapshot.state !== 'closed'
}

export function createStartupReadyHandler<T>(
  completeStartup: (source: T) => Promise<void>
): ((source: T) => Promise<void>) & { whenReady: Promise<void>; cancel: () => void } {
  let completion: Promise<void> | null = null
  let release!: () => void
  const whenReady = new Promise<void>(resolve => {
    release = resolve
  })
  const ready = (source: T) => {
    completion ??= Promise.resolve()
      .then(() => completeStartup(source))
      .then(release)
      .catch(error => {
        completion = null
        throw error
      })
    return completion
  }
  return Object.assign(ready, { whenReady, cancel: release })
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
  private closePromise: Promise<StartupSplashSnapshot> | null = null
  private showErrorPromise: Promise<void> | null = null
  private controlledClose = false
  private latestProgress: StartupProgressUpdate | null = null
  private handoffPromise: Promise<StartupSplashSnapshot> | null = null
  private handoffEvidence: StartupSplashSnapshot['handoff']
  private handoffGeneration = 0

  constructor(private readonly options: StartupSplashOptions) {
    this.now = options.now ?? Date.now
    this.persistPng = options.writePng ?? writePng
    options.window.on('close', event => {
      if (this.controlledClose) return
      event.preventDefault()
      options.onCloseRequest?.()
    })
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

  close(options: CloseStartupSplashOptions = {}): Promise<StartupSplashSnapshot> {
    if (this.state === 'closed') return Promise.resolve(this.snapshot())
    if (this.closePromise) return this.closePromise
    this.handoffGeneration += 1

    const operation = this.closeOnce(options)
    this.closePromise = operation.finally(() => {
      this.closePromise = null
    })
    return this.closePromise
  }

  handoff(options: StartupSplashHandoffOptions): Promise<StartupSplashSnapshot> {
    if (this.handoffPromise) return this.handoffPromise
    if (!options.update.completed) {
      return Promise.reject(new Error('Startup handoff requires completed startup progress'))
    }
    if (this.state !== 'visible') {
      return Promise.reject(new Error('Startup splash must be visible before handing off'))
    }
    const generation = ++this.handoffGeneration
    this.handoffPromise = this.performHandoff(options, generation)
      .catch(error => {
        this.restoreAfterInterruptedHandoff()
        throw error
      })
      .finally(() => {
        this.handoffPromise = null
      })
    return this.handoffPromise
  }

  /**
   * Mirrors the host startup stage into the splash. The latest update is kept
   * so a splash that becomes visible after the stage started still shows it.
   */
  updateProgress(update: StartupProgressUpdate): void {
    this.latestProgress = update
    if (this.state !== 'visible') return
    const contents = this.options.window.webContents
    if (contents.isDestroyed()) return
    contents.send(STARTUP_PROGRESS_CHANNEL, update)
  }

  showError(pluginName: string | null = null): Promise<void> {
    if (this.showErrorPromise) return this.showErrorPromise
    const target = this.options.window
    if (target.webContents.isDestroyed()) return Promise.resolve()
    this.handoffGeneration += 1
    this.restoreAfterInterruptedHandoff()
    this.showErrorPromise = target.webContents
      .executeJavaScript(
        `window.dispatchEvent(new CustomEvent('wework-startup-error', { detail: { pluginName: ${JSON.stringify(
          pluginName
        )} } })); true`
      )
      .then(() => undefined)
      .finally(() => {
        this.showErrorPromise = null
      })
    return this.showErrorPromise
  }

  private async performHandoff(
    options: StartupSplashHandoffOptions,
    generation: number
  ): Promise<StartupSplashSnapshot> {
    const active = () =>
      generation === this.handoffGeneration &&
      !this.options.window.isDestroyed() &&
      options.shouldContinue()
    this.state = 'completing'
    this.record('completion-started')
    const completion = (await finishStartupAnimation(() =>
      this.options.window.webContents.executeJavaScript(
        `window.weworkStartupSplash.complete(${JSON.stringify(options.update)})`
      )
    )) as StartupSplashCompletion
    if (!active()) return this.interruptedHandoff()
    this.record('completed')
    await finishStartupAnimation(() => this.capture(options.capturePath))
    if (!active()) return this.interruptedHandoff()
    // Native window preparation has its own bounds/capture deadlines. It must
    // not consume the subsequent fade's independent animation budget.
    const bounds = await options.prepareMainWindow()
    if (!active()) return this.interruptedHandoff()
    this.handoffEvidence = {
      fadeDurationMs: STARTUP_SPLASH_FADE_MS,
      reducedMotion: completion.reducedMotion,
      completion,
      bounds,
    }
    this.record('main-prepared')
    if (!(await finishStartupAnimation(() => this.fadeOut(completion.reducedMotion, active)))) {
      return this.interruptedHandoff()
    }
    return this.close()
  }

  private async fadeOut(reducedMotion: boolean, active: () => boolean): Promise<boolean> {
    this.state = 'fading'
    this.record('fade-started')
    const startedAt = performance.now()
    const finished = await new Promise<boolean>((resolve, reject) => {
      const step = () => {
        try {
          if (!active()) return resolve(false)
          const elapsed = performance.now() - startedAt
          const amount = reducedMotion ? 1 : Math.min(1, elapsed / STARTUP_SPLASH_FADE_MS)
          this.options.window.setOpacity(1 - amount * amount * (3 - 2 * amount))
          if (amount === 1) resolve(true)
          else setTimeout(step, Math.min(16, STARTUP_SPLASH_FADE_MS - elapsed))
        } catch (error) {
          reject(error)
        }
      }
      step()
    })
    if (finished) this.record('fade-completed')
    return finished
  }

  private interruptedHandoff(): StartupSplashSnapshot {
    this.restoreAfterInterruptedHandoff()
    return this.snapshot()
  }

  private restoreAfterInterruptedHandoff(): void {
    if (this.state !== 'completing' && this.state !== 'fading') return
    if (!this.options.window.isDestroyed()) this.options.window.setOpacity(1)
    this.state = 'visible'
  }

  private async capture(path?: string): Promise<void> {
    if (!path) return
    const image = await this.options.window.webContents.capturePage()
    await this.persistPng(path, image.toPNG())
  }

  private async closeOnce(options: CloseStartupSplashOptions): Promise<StartupSplashSnapshot> {
    const target = this.options.window
    if (target.isDestroyed()) {
      this.markClosed()
      return this.snapshot()
    }

    try {
      await this.capture(options.capturePath)
    } finally {
      if (!target.isDestroyed()) {
        this.controlledClose = true
        target.close()
      }
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
      ...(this.handoffEvidence ? { handoff: structuredClone(this.handoffEvidence) } : {}),
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
    target.once('closed', () => this.markClosed())

    if (!target.webContents.isDestroyed()) {
      void target.webContents
        .executeJavaScript(WAIT_FOR_ANIMATION_READY)
        .then(() => {
          this.record('animation-ready')
        })
        .catch(error => {
          console.warn('[startup-splash] animation initialization failed', error)
        })
    }
    if (!target.isDestroyed()) {
      await target.show()
      if (target.isDestroyed()) return this.snapshot()
      this.state = 'visible'
      this.record('shown')
      if (this.latestProgress && !target.webContents.isDestroyed()) {
        target.webContents.send(STARTUP_PROGRESS_CHANNEL, this.latestProgress)
      }
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
