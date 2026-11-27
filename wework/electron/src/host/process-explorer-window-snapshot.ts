import type { BrowserWindow } from 'electron'

export interface ProcessExplorerRowSnapshot {
  pid: number
  exited: boolean
  uptime: string
}

interface ProcessExplorerContentsSnapshot {
  url: string
  windowLabel: string
  testIds: string[]
  text: string
  /** The document state that suspends automatic sampling while hidden. */
  visibility: string
  summary: string
  rows: ProcessExplorerRowSnapshot[]
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

const ROW_TEST_ID_PREFIX = 'process-explorer-row-'

const SNAPSHOT_SCRIPT = `(() => {
  const table = document.querySelector('table')
  return {
    url: window.location.href,
    windowLabel: window.__WEWORK_RUNTIME_CONFIG__?.desktopWindowLabel ?? '',
    text: document.body.innerText,
    visibility: document.visibilityState,
    summary: document.querySelector('[data-testid="process-explorer-summary"]')?.textContent ?? '',
    rows: Array.from(document.querySelectorAll('tr[data-testid^="${ROW_TEST_ID_PREFIX}"]')).map(row => ({
      pid: Number(row.getAttribute('data-testid').slice('${ROW_TEST_ID_PREFIX}'.length)),
      exited: row.getAttribute('data-state') === 'exited',
      uptime: row.cells[4]?.textContent?.trim() ?? ''
    })),
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
    visibility: '',
    summary: '',
    rows: [],
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
