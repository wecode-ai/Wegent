import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  GetWindowStateInput,
  ListWindowsInput,
  ListWindowsOutput,
  WindowInfo,
  WindowStateOutput,
} from '@trycua/cua-driver'
import { globalShortcut, shell, systemPreferences } from 'electron'
import { ComputerUseDriverProcess } from './computer-use-driver-process.js'
import {
  GlobalShortcutController,
  type GlobalShortcutRegistry,
} from './global-shortcut-controller.js'

export const APPSHOT_CAPTURED_EVENT = 'wework-appshot-captured'
export const APPSHOT_FAILED_EVENT = 'wework-appshot-failed'

export type AppshotPermission = 'screenCapture' | 'accessibility'

export interface AppshotsStatus {
  supported: boolean
  shortcut: string | null
  shortcutRegistered: boolean
  screenCapturePermissionGranted: boolean
  accessibilityPermissionGranted: boolean
}

interface AppshotPermissions {
  screenRecording: boolean
  accessibility: boolean
}

interface AppshotEventPublisher {
  publish(type: string, payload: Record<string, unknown>): number
}

export interface AppshotDriver {
  listWindows(input: ListWindowsInput): Promise<ListWindowsOutput>
  getWindowState(input: GetWindowStateInput): Promise<WindowStateOutput>
  shutdown(): Promise<void>
}

export interface AppshotsServiceOptions {
  captureRoot: string
  events: AppshotEventPublisher
  showMain: () => void | Promise<void>
  playSound?: () => void | Promise<void>
  platform?: NodeJS.Platform
  appPid?: number
  shortcutRegistry?: GlobalShortcutRegistry
  createDriver?: () => Promise<AppshotDriver>
  readPermissions?: () => Promise<AppshotPermissions>
  requestPermissions?: () => Promise<AppshotPermissions>
  openScreenRecordingSettings?: () => Promise<void>
  openAccessibilitySettings?: () => Promise<void>
  createId?: () => string
}

export class AppshotsService {
  private shortcut: string | null = null
  private registeredShortcut: string | null = null
  private driverPromise: Promise<AppshotDriver> | null = null
  private driverGeneration = 0
  private permissionsRequested = false
  private stopped = false

  private readonly platform: NodeJS.Platform
  private readonly appPid: number
  private readonly shortcutController: GlobalShortcutController
  private readonly createDriver: () => Promise<AppshotDriver>
  private readonly readPermissions: () => Promise<AppshotPermissions>
  private readonly requestPermissions: () => Promise<AppshotPermissions>
  private readonly openScreenRecordingSettings: () => Promise<void>
  private readonly openAccessibilitySettings: () => Promise<void>
  private readonly createId: () => string

  constructor(private readonly options: AppshotsServiceOptions) {
    this.platform = options.platform ?? process.platform
    this.appPid = options.appPid ?? process.pid
    this.createDriver = options.createDriver ?? (() => this.createDefaultDriver())
    this.readPermissions = options.readPermissions ?? (() => this.readMacOsPermissions())
    this.requestPermissions = options.requestPermissions ?? (() => this.requestMacOsPermissions())
    this.openScreenRecordingSettings =
      options.openScreenRecordingSettings ?? (() => openMacOsScreenRecordingSettings())
    this.openAccessibilitySettings =
      options.openAccessibilitySettings ?? (() => openMacOsAccessibilitySettings())
    this.createId = options.createId ?? randomUUID
    this.shortcutController = new GlobalShortcutController(
      options.shortcutRegistry ?? globalShortcut,
      () => this.capture(),
      error => this.reportFailure(error)
    )
  }

  configure(shortcut: string | null): void {
    const nextShortcut = shortcut?.trim() || null
    if (this.platform !== 'darwin') {
      this.shortcut = nextShortcut
      this.registeredShortcut = null
      return
    }
    try {
      this.shortcutController.configure(nextShortcut)
      this.registeredShortcut = nextShortcut
    } finally {
      this.shortcut = nextShortcut
    }
  }

  async status(): Promise<AppshotsStatus> {
    const permissions = await this.readPermissions().catch(() => ({
      screenRecording: false,
      accessibility: false,
    }))
    return {
      supported: this.platform === 'darwin',
      shortcut: this.shortcut,
      shortcutRegistered: this.shortcut !== null && this.registeredShortcut === this.shortcut,
      screenCapturePermissionGranted: permissions.screenRecording,
      accessibilityPermissionGranted: permissions.accessibility,
    }
  }

  async openPermissionSettings(permission: AppshotPermission): Promise<void> {
    if (this.platform !== 'darwin') {
      throw new Error('Appshot permissions are available only on macOS')
    }
    if (permission === 'screenCapture') {
      await this.openScreenRecordingSettings()
      return
    }
    await this.openAccessibilitySettings()
  }

  async capture(): Promise<void> {
    if (this.stopped) throw new Error('Appshots are stopping')
    if (this.platform !== 'darwin') {
      throw new Error('Appshots are available only on macOS')
    }

    let permissions = await this.readPermissions()
    if (
      !this.permissionsRequested &&
      (!permissions.screenRecording || !permissions.accessibility)
    ) {
      this.permissionsRequested = true
      permissions = await this.requestPermissions().catch(error => {
        this.permissionsRequested = false
        console.warn('[appshots] Unable to request macOS permissions', error)
        return permissions
      })
    }
    if (!permissions.screenRecording) {
      await this.openScreenRecordingSettings()
      throw new Error('Screen recording access is required to capture an appshot')
    }

    const driver = await this.requireDriver()
    const windows = await driver.listWindows({ onScreenOnly: true })
    const target = selectFrontmostWindow(windows, this.appPid)
    if (!target || target.pid === undefined) {
      throw new Error('No frontmost application window is available to capture')
    }

    const captureId = this.createId()
    const captureDirectory = join(this.options.captureRoot, captureId)
    const screenshotPath = join(captureDirectory, 'appshot.png')
    let completed = false
    try {
      await mkdir(captureDirectory, { recursive: true, mode: 0o700 })
      const windowState = await driver.getWindowState({
        pid: target.pid,
        windowId: target.windowId,
        includeAccessibilityTree: permissions.accessibility,
        includeScreenshot: true,
        screenshotOutFile: screenshotPath,
        treeFormat: 'markdown',
        maxElements: 20_000,
        timeoutMs: 5_000,
      })
      const screenshot = await stat(screenshotPath)
      if (!screenshot.isFile() || screenshot.size === 0) {
        throw new Error('The appshot image was not written')
      }

      const text = appshotText(windowState, target)
      const textAttachment = text
        ? await writeTextContext(captureDirectory, text).catch(error => {
            console.warn('[appshots] Captured the image but could not write text context', error)
            return null
          })
        : null

      this.options.events.publish(APPSHOT_CAPTURED_EVENT, {
        id: captureId,
        filename: 'appshot.png',
        mimeType: 'image/png',
        fileSize: screenshot.size,
        path: screenshotPath,
        textAttachment,
      })
      completed = true
      console.info('[window-activation]', { reason: 'appshot-reveal' })
      void Promise.resolve()
        .then(() => this.options.showMain())
        .catch(error => {
          console.error('[appshots] Captured the window but could not reveal Wework', error)
        })
      await Promise.resolve(this.options.playSound?.()).catch(error => {
        console.warn('[appshots] Unable to play the capture sound', error)
      })
    } finally {
      if (!completed) {
        await rm(captureDirectory, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.shortcutController.dispose()
    this.shortcut = null
    this.registeredShortcut = null
    const driver = await this.driverPromise?.catch(() => null)
    this.driverPromise = null
    await driver?.shutdown().catch(() => undefined)
  }

  private async createDefaultDriver(): Promise<AppshotDriver> {
    const generation = ++this.driverGeneration
    return ComputerUseDriverProcess.create(error => {
      console.error('[appshots] Capture driver stopped unexpectedly', error)
      if (this.driverGeneration === generation) this.driverPromise = null
    })
  }

  private requireDriver(): Promise<AppshotDriver> {
    if (!this.driverPromise) {
      this.driverPromise = this.createDriver().catch(error => {
        this.driverPromise = null
        throw error
      })
    }
    return this.driverPromise
  }

  private reportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[appshots] Capture failed', error)
    this.options.events.publish(APPSHOT_FAILED_EVENT, { message })
  }

  private async readMacOsPermissions(): Promise<AppshotPermissions> {
    if (this.platform !== 'darwin') return { screenRecording: false, accessibility: false }
    return {
      screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    }
  }

  private async requestMacOsPermissions(): Promise<AppshotPermissions> {
    if (this.platform !== 'darwin') return this.readMacOsPermissions()
    const { requestMacOSPermissions } = await import('@trycua/cua-driver/electron')
    return requestMacOSPermissions()
  }
}

export function selectFrontmostWindow(
  windows: Pick<ListWindowsOutput, 'windows'>,
  appPid: number
): WindowInfo | null {
  const candidates = windows.windows.filter(
    window =>
      window.pid !== undefined &&
      window.pid !== appPid &&
      window.isOnScreen &&
      window.minimized !== true &&
      (window.layer ?? 0) === 0 &&
      window.onCurrentSpace !== false &&
      window.zIndex !== undefined &&
      window.bounds.width > 0 &&
      window.bounds.height > 0
  )
  candidates.sort((left, right) => {
    const leftZ = left.zIndex as bigint
    const rightZ = right.zIndex as bigint
    return leftZ === rightZ ? 0 : leftZ > rightZ ? -1 : 1
  })
  return candidates[0] ?? null
}

export function appshotText(state: WindowStateOutput, target: WindowInfo): string | null {
  const heading = [state.appName ?? target.appName, state.windowTitle ?? target.title]
    .map(value => value.trim())
    .filter(Boolean)
    .join(' — ')
  const tree = state.treeMarkdown?.trim() || ''
  const text = [heading, tree].filter(Boolean).join('\n\n')
  return text || null
}

async function writeTextContext(
  captureDirectory: string,
  text: string
): Promise<{
  filename: string
  fileSize: number
  path: string
  textLength: number
  textPreview: string
}> {
  const path = join(captureDirectory, 'appshot-context.txt')
  await writeFile(path, text, { mode: 0o600 })
  const metadata = await stat(path)
  return {
    filename: 'appshot-context.txt',
    fileSize: metadata.size,
    path,
    textLength: text.length,
    textPreview: text.slice(0, 500),
  }
}

async function openMacOsScreenRecordingSettings(): Promise<void> {
  const { openMacOSScreenRecordingSettings } = await import('@trycua/cua-driver/electron')
  await openMacOSScreenRecordingSettings()
}

async function openMacOsAccessibilitySettings(): Promise<void> {
  await shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
  )
}
