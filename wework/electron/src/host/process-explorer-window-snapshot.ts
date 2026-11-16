import type { BrowserWindow } from 'electron'

interface ProcessExplorerContentsSnapshot {
  url: string
  windowLabel: string
  testIds: string[]
  text: string
  layout: { viewportWidth: number; tableClientWidth: number; tableScrollWidth: number }
}

export interface ProcessExplorerWindowSnapshot extends ProcessExplorerContentsSnapshot {
  exists: boolean
  visible: boolean
  applicationPid: number
  windowWidth: number
  windowHeight: number
  alwaysOnTop: boolean
  menuBarVisible: boolean
}

const SNAPSHOT_SCRIPT = `(() => {
  const table = document.querySelector('table')
  return {
    url: window.location.href,
    windowLabel: window.__WEWORK_RUNTIME_CONFIG__?.desktopWindowLabel ?? '',
    text: document.body.innerText,
    testIds: Array.from(document.querySelectorAll('[data-testid]'))
      .map(element => element.getAttribute('data-testid'))
      .filter(value => typeof value === 'string'),
    layout: {
      viewportWidth: document.documentElement.clientWidth,
      tableClientWidth: table?.clientWidth ?? 0,
      tableScrollWidth: table?.scrollWidth ?? 0
    }
  }
})()`

function absentWindow(applicationPid: number): ProcessExplorerWindowSnapshot {
  return {
    exists: false,
    visible: false,
    applicationPid,
    url: '',
    windowLabel: '',
    windowWidth: 0,
    windowHeight: 0,
    alwaysOnTop: false,
    menuBarVisible: false,
    testIds: [],
    text: '',
    layout: { viewportWidth: 0, tableClientWidth: 0, tableScrollWidth: 0 },
  }
}

export async function captureProcessExplorerWindowSnapshot(
  target: BrowserWindow | null,
  applicationPid: number
): Promise<ProcessExplorerWindowSnapshot> {
  if (!target || target.isDestroyed()) return absentWindow(applicationPid)
  const contents = await readWindowContents(target)
  if (!contents || target.isDestroyed() || target.webContents.isDestroyed())
    return absentWindow(applicationPid)
  const bounds = target.getBounds()
  return {
    ...contents,
    exists: true,
    visible: target.isVisible(),
    applicationPid,
    windowWidth: bounds.width,
    windowHeight: bounds.height,
    alwaysOnTop: target.isAlwaysOnTop(),
    menuBarVisible: target.isMenuBarVisible(),
  }
}

/** Closing a window can abandon its renderer's pending script response. */
async function readWindowContents(
  target: BrowserWindow
): Promise<ProcessExplorerContentsSnapshot | null> {
  const contents = target.webContents
  const unavailable = () => target.isDestroyed() || contents.isDestroyed()
  if (unavailable()) return null
  let onClosed!: () => void
  const closed = new Promise<null>(resolve => {
    onClosed = () => resolve(null)
  })
  target.once('closed', onClosed)
  contents.once('destroyed', onClosed)
  try {
    if (unavailable()) return null
    const scriptResult: Promise<ProcessExplorerContentsSnapshot> =
      contents.executeJavaScript(SNAPSHOT_SCRIPT)
    return await Promise.race([scriptResult, closed])
  } catch (error) {
    if (unavailable()) return null
    throw error
  } finally {
    target.removeListener('closed', onClosed)
    contents.removeListener('destroyed', onClosed)
  }
}
