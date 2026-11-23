import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const ACTIVE_WEBVIEW_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"] [data-testid="workspace-browser-electron-webview-placeholder"]'
const POPUP_MENU_WINDOW_TYPES = new Set([
  '_NET_WM_WINDOW_TYPE_POPUP_MENU',
  '_NET_WM_WINDOW_TYPE_MENU',
  '_NET_WM_WINDOW_TYPE_DROPDOWN_MENU',
])

let diagnosticSequence = 0

function isVanishedX11Window(error) {
  return error?.code === 1 && /BadWindow \(invalid Window parameter\)/.test(error.stderr ?? '')
}

function isEmptyXdotoolSearch(error) {
  return error?.code === 1 && !(error.stderr ?? '').trim()
}

async function xdotoolSearch(args, timeoutMs) {
  try {
    const { stdout } = await execute('xdotool', ['search', ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
    })
    return stdout.trim().split(/\s+/).filter(Boolean)
  } catch (error) {
    if (isEmptyXdotoolSearch(error) || isVanishedX11Window(error)) return []
    throw error
  }
}

async function readWindowProperties(windowId, timeoutMs) {
  try {
    const { stdout } = await execute(
      'xprop',
      [
        '-id',
        windowId,
        '_NET_WM_WINDOW_TYPE',
        '_NET_WM_NAME',
        'WM_NAME',
        'WM_CLASS',
        '_NET_WM_PID',
      ],
      { encoding: 'utf8', timeout: timeoutMs }
    )
    const typeLine = stdout.match(/_NET_WM_WINDOW_TYPE\(ATOM\)\s*=\s*(.+)/)?.[1] ?? ''
    const utf8Name = stdout.match(/_NET_WM_NAME\(UTF8_STRING\)\s*=\s*"(.*)"/)?.[1]
    const wmName = stdout.match(/WM_NAME\(STRING\)\s*=\s*"(.*)"/)?.[1]
    const pidText = stdout.match(/_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/)?.[1]
    return {
      windowId,
      types: typeLine
        .split(',')
        .map(part => part.trim())
        .filter(Boolean),
      title: utf8Name ?? wmName ?? '',
      pid: pidText ? Number(pidText) : null,
      raw: stdout,
    }
  } catch (error) {
    if (isVanishedX11Window(error)) return null
    if (error?.code === 1 && /BadWindow|no such window/i.test(error.stderr ?? '')) return null
    throw error
  }
}

async function listVisibleWindowsForPid(pid, timeoutMs = 2_000) {
  return xdotoolSearch(['--all', '--onlyvisible', '--pid', String(pid)], timeoutMs)
}

async function listVisiblePopupMenus(pid, timeoutMs = 2_000) {
  const candidates = new Set([
    ...(await listVisibleWindowsForPid(pid, timeoutMs)),
    ...(await xdotoolSearch(['--all', '--onlyvisible', '--classname', '.'], timeoutMs)),
  ])
  const results = []
  for (const windowId of candidates) {
    const props = await readWindowProperties(windowId, timeoutMs)
    if (props?.types.some(type => POPUP_MENU_WINDOW_TYPES.has(type))) {
      results.push(windowId)
    }
  }
  return results
}

export async function listVisibleDialogsForPid(pid, timeoutMs = 2_000) {
  const windows = await listVisibleWindowsForPid(pid, timeoutMs)
  const dialogs = []
  for (const windowId of windows) {
    const props = await readWindowProperties(windowId, timeoutMs)
    if (props?.types.includes('_NET_WM_WINDOW_TYPE_DIALOG')) {
      dialogs.push(props)
    }
  }
  return dialogs
}

async function findMainWindowForPid(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const windows = await listVisibleWindowsForPid(pid, 2_000)
    for (const windowId of windows) {
      const props = await readWindowProperties(windowId, 1_500)
      if (!props) continue
      if (
        props.types.includes('_NET_WM_WINDOW_TYPE_NORMAL') ||
        (!props.types.includes('_NET_WM_WINDOW_TYPE_DIALOG') &&
          !props.types.includes('_NET_WM_WINDOW_TYPE_POPUP_MENU'))
      ) {
        return windowId
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for visible Electron main window for pid ${pid}`)
}

async function captureNativeDiagnostics(pid, resultDir, stepName, targetWindowId = null) {
  const diagnostics = { pid, stepName, windows: [], screenshot: null }
  try {
    const candidateIds = new Set([
      ...(await listVisibleWindowsForPid(pid, 2_000)),
      ...(await xdotoolSearch(['--all', '--onlyvisible', '--classname', '.'], 2_000)),
    ])
    for (const windowId of candidateIds) {
      const props = await readWindowProperties(windowId, 1_500)
      if (props) {
        diagnostics.windows.push({
          windowId: props.windowId,
          pid: props.pid,
          title: props.title,
          types: props.types,
        })
      }
    }
  } catch (error) {
    diagnostics.windowLookupError = String(error)
  }
  if (resultDir) {
    const screenshotPath = join(
      resultDir,
      `native-download-dialog-${++diagnosticSequence}-${stepName.replace(/[^a-z0-9_-]/gi, '-')}.png`
    )
    try {
      await execute('import', ['-window', targetWindowId ?? 'root', screenshotPath], {
        encoding: 'utf8',
        timeout: 2_000,
      })
      diagnostics.screenshot = screenshotPath
    } catch {
      // ImageMagick import may not be available in every environment.
    }
  }
  console.error('[native-download-dialog-diagnostics]', JSON.stringify(diagnostics))
  return diagnostics
}

async function waitForWindowToClose(pid, windowId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const visible = await listVisibleWindowsForPid(pid, 2_000)
    if (!visible.includes(windowId)) return true
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  return false
}

export async function assertNoNativeSaveDialog(pid, existingDialogIds = new Set()) {
  if (process.platform !== 'linux') return
  const dialogs = await listVisibleDialogsForPid(pid)
  const unexpected = dialogs.filter(dialog => !existingDialogIds.has(dialog.windowId))
  assert.deepEqual(
    unexpected.map(dialog => ({ windowId: dialog.windowId, title: dialog.title })),
    [],
    'Unexpected native save dialog appeared during direct download'
  )
}

export async function triggerEmbeddedBrowserContextMenuItem({
  bridgeCall,
  control,
  downCount,
  resultDir,
  stepName,
  targetSelector,
  timeoutMs = 8_000,
}) {
  assert.equal(
    process.platform,
    'linux',
    'Native context-menu E2E automation currently expects Linux Xvfb'
  )
  const pid = control.applicationProcessId
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'An isolated Electron PID is required')

  await control.command('focusMainWindow', 'body')
  const mainWindowId = await findMainWindowForPid(pid, timeoutMs)
  await execute('xdotool', ['windowactivate', '--sync', mainWindowId], {
    encoding: 'utf8',
    timeout: 3_000,
  })

  const webviewMetrics = JSON.parse(
    await control.command('getElementMetrics', ACTIVE_WEBVIEW_SELECTOR)
  )
  assert.equal(
    webviewMetrics.length,
    1,
    `Expected exactly one active embedded browser webview for ${stepName}`
  )
  const webviewRect = webviewMetrics[0]

  const elementEval = await bridgeCall({
    action: 'evaluate',
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(targetSelector)})
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    })()`,
    timeoutMs: 5_000,
  })
  const elementRect = elementEval?.value ?? elementEval?.result ?? null
  assert.ok(
    elementRect && elementRect.width > 0 && elementRect.height > 0,
    `Failed to resolve embedded browser target rect for ${targetSelector}: ${JSON.stringify(elementEval)}`
  )

  const x = Math.round(webviewRect.left + elementRect.left + elementRect.width / 2)
  const y = Math.round(webviewRect.top + elementRect.top + elementRect.height / 2)
  const existingPopups = new Set(await listVisiblePopupMenus(pid))

  await execute(
    'xdotool',
    ['mousemove', '--window', mainWindowId, String(x), String(y), 'click', '--clearmodifiers', '3'],
    {
      encoding: 'utf8',
      timeout: 3_000,
    }
  )

  const menuDeadline = Date.now() + Math.min(timeoutMs, 5_000)
  let menuWindowId = null
  while (Date.now() < menuDeadline) {
    const popups = await listVisiblePopupMenus(pid, 1_500)
    const created = popups.find(windowId => !existingPopups.has(windowId))
    if (created) {
      menuWindowId = created
      break
    }
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  if (!menuWindowId) {
    const diagnostics = await captureNativeDiagnostics(pid, resultDir, `${stepName}-menu`)
    throw new Error(
      `Timed out waiting for native embedded-browser context menu (${stepName}) at (${x}, ${y}): ${JSON.stringify(diagnostics)}`
    )
  }

  const keys = [...Array.from({ length: downCount }, () => 'Down'), 'Return']
  await execute('xdotool', ['key', '--clearmodifiers', '--delay', '50', ...keys], {
    encoding: 'utf8',
    timeout: 4_000,
  })

  const closeDeadline = Date.now() + 4_000
  while (Date.now() < closeDeadline) {
    const popups = await listVisiblePopupMenus(pid, 1_500)
    if (!popups.includes(menuWindowId)) return { menuWindowId, x, y }
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  const diagnostics = await captureNativeDiagnostics(
    pid,
    resultDir,
    `${stepName}-menu-stuck`,
    menuWindowId
  )
  throw new Error(
    `Native context menu did not close after selecting item (${stepName}): ${JSON.stringify(diagnostics)}`
  )
}

async function handleNativeSaveDialogWindow({
  action,
  existingDialogIds,
  pid,
  resultDir,
  savePath,
  signal,
  stepName,
  timeoutMs,
}) {
  const appearDeadline = Date.now() + timeoutMs
  let dialog = null
  while (Date.now() < appearDeadline) {
    if (signal.aborted) return null
    const visibleDialogs = await listVisibleDialogsForPid(pid, 1_500)
    const created = visibleDialogs.find(candidate => !existingDialogIds.has(candidate.windowId))
    if (created) {
      dialog = created
      break
    }
    await new Promise(resolve => setTimeout(resolve, 80))
  }

  if (signal.aborted) return null
  if (!dialog) {
    const diagnostics = await captureNativeDiagnostics(pid, resultDir, `${stepName}-missing`)
    throw new Error(
      `Timed out waiting for native OS save dialog (${stepName}): ${JSON.stringify(diagnostics)}`
    )
  }

  await execute('xdotool', ['windowactivate', '--sync', dialog.windowId], {
    encoding: 'utf8',
    timeout: 3_000,
  })
  await execute('xdotool', ['windowfocus', '--sync', dialog.windowId], {
    encoding: 'utf8',
    timeout: 3_000,
  })

  if (action === 'cancel') {
    await execute('xdotool', ['key', '--clearmodifiers', 'Escape'], {
      encoding: 'utf8',
      timeout: 3_000,
    })
    let closed = await waitForWindowToClose(pid, dialog.windowId, 2_000)
    if (!closed) {
      await execute('xdotool', ['key', '--clearmodifiers', 'Escape'], {
        encoding: 'utf8',
        timeout: 3_000,
      })
      closed = await waitForWindowToClose(pid, dialog.windowId, 3_000)
    }
    if (!closed) {
      const diagnostics = await captureNativeDiagnostics(
        pid,
        resultDir,
        `${stepName}-cancel-stuck`,
        dialog.windowId
      )
      throw new Error(
        `Native OS save dialog did not close after Escape (${stepName}): ${JSON.stringify(diagnostics)}`
      )
    }
    return dialog
  }

  if (savePath) {
    await execute('xdotool', ['key', '--clearmodifiers', 'ctrl+l'], {
      encoding: 'utf8',
      timeout: 3_000,
    })
    await execute('xdotool', ['key', '--clearmodifiers', 'ctrl+a', 'BackSpace'], {
      encoding: 'utf8',
      timeout: 3_000,
    })
    await execute('xdotool', ['type', '--clearmodifiers', '--delay', '5', '--', savePath], {
      encoding: 'utf8',
      timeout: 5_000,
    })
  }

  await execute('xdotool', ['key', '--clearmodifiers', 'Return'], {
    encoding: 'utf8',
    timeout: 3_000,
  })
  let closed = await waitForWindowToClose(pid, dialog.windowId, 1_500)
  if (!closed) {
    await execute('xdotool', ['key', '--clearmodifiers', 'Return'], {
      encoding: 'utf8',
      timeout: 3_000,
    })
    closed = await waitForWindowToClose(pid, dialog.windowId, 2_000)
  }
  if (!closed) {
    await execute('xdotool', ['key', '--clearmodifiers', 'alt+s'], {
      encoding: 'utf8',
      timeout: 3_000,
    })
    closed = await waitForWindowToClose(pid, dialog.windowId, 2_500)
  }
  if (!closed) {
    const diagnostics = await captureNativeDiagnostics(
      pid,
      resultDir,
      `${stepName}-save-stuck`,
      dialog.windowId
    )
    throw new Error(
      `Native OS save dialog did not close after confirming save (${stepName}): ${JSON.stringify(diagnostics)}`
    )
  }
  return dialog
}

export async function withNativeSaveDialog(
  control,
  triggerDownload,
  { action, savePath = null, resultDir = null, stepName, timeoutMs = 10_000 }
) {
  assert.equal(
    process.platform,
    'linux',
    'Native save-dialog E2E automation currently expects Linux Xvfb'
  )
  const pid = control.applicationProcessId
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'An isolated Electron PID is required')

  const existingDialogIds = new Set(
    (await listVisibleDialogsForPid(pid)).map(dialog => dialog.windowId)
  )
  const abort = new AbortController()
  const dialogPromise = handleNativeSaveDialogWindow({
    action,
    existingDialogIds,
    pid,
    resultDir,
    savePath,
    signal: abort.signal,
    stepName,
    timeoutMs,
  })
  try {
    const [, dialog] = await Promise.all([triggerDownload(), dialogPromise])
    assert.ok(dialog, `Native OS save dialog did not complete (${stepName})`)
    return dialog
  } finally {
    abort.abort()
    await dialogPromise.catch(() => {})
  }
}
