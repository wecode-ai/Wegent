import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, shell } from 'electron'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHANNEL = 'startup-recovery-window'
let recoveryWindow: BrowserWindow | null = null
let opening: Promise<BrowserWindow> | null = null
let failure = ''
let recoveryActive = false

/** Reopening the app must not return to a stopped or uninitialized workbench. */
export function focusStartupRecoveryIfActive(): boolean {
  if (!recoveryActive) return false
  void showStartupRecovery(failure).catch(error => {
    console.error('[startup-recovery] Cannot restore recovery window', error)
  })
  return true
}

/** Open without loading application stores, credentials, migrations, or runtimes. */
export function showStartupRecovery(error: unknown): Promise<BrowserWindow> {
  recoveryActive = true
  failure = error instanceof Error ? error.message : String(error)
  if (recoveryWindow && !recoveryWindow.isDestroyed()) {
    recoveryWindow.show()
    recoveryWindow.focus()
    recoveryWindow.webContents.send('runtime:changed')
    return Promise.resolve(recoveryWindow)
  }
  opening ??= app
    .whenReady()
    .then(openRecoveryWindow)
    .finally(() => {
      opening = null
    })
  return opening
}

async function openRecoveryWindow(): Promise<BrowserWindow> {
  // A failed release handoff may have prohibited the bridge from showing UI.
  if (process.platform === 'darwin') app.setActivationPolicy('regular')
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const window = new BrowserWindow({
    title: 'Wework',
    width: 720,
    height: 600,
    show: false,
    webPreferences: {
      preload: resolve(dist, 'startup-recovery-preload.cjs'),
      // Recovery must not open the failed profile's Chromium databases either.
      partition: 'wework-startup-recovery',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  recoveryWindow = window
  ipcMain.handle(CHANNEL, async (event, action: string) => {
    if (window.isDestroyed() || event.sender.id !== window.webContents.id) {
      throw new Error('Startup recovery request belongs to another window')
    }
    if (action === 'state') return { phase: 'failed', ready: false, error: failure }
    if (action === 'copy') return clipboard.writeText(failure)
    if (action === 'logs') return shell.openPath(app.getPath('logs'))
    if (action === 'retry') {
      app.relaunch()
      app.quit()
      return
    }
    throw new Error('Unknown startup recovery action')
  })
  window.once('closed', () => {
    ipcMain.removeHandler(CHANNEL)
    if (recoveryWindow === window) recoveryWindow = null
  })
  try {
    await window.loadFile(resolve(dist, 'shell/index.html'), {
      query: { theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', recovery: '1' },
    })
    window.show()
    return window
  } catch (error) {
    window.destroy()
    throw error
  }
}
