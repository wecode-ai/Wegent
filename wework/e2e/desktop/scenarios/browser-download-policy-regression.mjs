import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { withProjectRenderer } from '../modules/project-create-test-utils.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import {
  assertNoNativeSaveDialog,
  triggerEmbeddedBrowserContextMenuItem,
  withNativeSaveDialog,
} from '../modules/native-download-dialogs.mjs'

const DOWNLOAD_FIXTURE_PATH = '/embedded-browser-download-fixture/orders/return'
const DOWNLOAD_OAUTH_CALLBACK_PATH = '/embedded-browser-download-fixture/oauth2callback'
const DOWNLOAD_FILE_PATH = '/embedded-browser-download-file'
const DOWNLOAD_SAVE_AS_REDIRECT_PATH = '/embedded-browser-download-save-as-redirect'
const DOWNLOAD_IMAGE_PATH = '/embedded-browser-download-image.png'
const DOWNLOAD_FIXTURE_TITLE = 'Embedded Browser Download Policy Fixture'
const ACTIVE_WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const DOWNLOAD_BUTTON = `${ACTIVE_WORKBENCH} [data-testid="workspace-browser-downloads-button"]`
const DOWNLOAD_PANEL = '[data-testid="workspace-browser-downloads-panel"]'
const DOWNLOAD_RETRY = `${DOWNLOAD_PANEL} [data-testid="workspace-browser-downloads-retry"]`
const RETRY_RACE_FILE = 'retry-race.mp4'
const CLEAR_HISTORY_FILE = 'keep-after-clearing.txt'
const HELD_DOWNLOAD_CONTENT = 'CUSTOM_DIR_BYTES'.repeat(256)
const heldDownloadGates = new Map()

// Valid 1x1 red PNG bytes served for the real image right-click Save Image As flow.
const TEST_IMAGE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
)

// Menu positions in the unified embedded browser context menu (separators are skipped by Down).
// Link menu: Quick annotate(1), Annotate(2), Open Link in New Tab(3), Open in External Browser(4),
// Copy Link Address(5), Save Link As...(6).
const LINK_SAVE_AS_MENU_DOWN_COUNT = 6
// Image menu: Quick annotate(1), Annotate(2), Open Image in New Tab(3), Save Image As...(4).
const IMAGE_SAVE_AS_MENU_DOWN_COUNT = 4

function downloadFixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${DOWNLOAD_FIXTURE_TITLE}</title>
    <style>
      body {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 3px;
        margin: 0;
        padding: 8px 12px;
        font: 12px/1.3 sans-serif;
      }
      h1 {
        margin: 0 0 4px;
        font-size: 14px;
      }
      a {
        display: inline-block;
        white-space: nowrap;
      }
      img {
        display: block;
        width: 48px;
        height: 48px;
        margin: 2px 0;
      }
    </style>
  </head>
  <body>
    <h1>${DOWNLOAD_FIXTURE_TITLE}</h1>
    <a id="download-single" download="clip.mp4" href="${DOWNLOAD_FILE_PATH}?name=clip.mp4&body=SINGLE_CLIP_BYTES">Download single</a>
    <a id="download-concurrent-1" download="clip.mp4" href="${DOWNLOAD_FILE_PATH}?name=clip.mp4&delay=1500&body=CONCURRENT_ONE">Download concurrent 1</a>
    <a id="download-concurrent-2" download="clip.mp4" href="${DOWNLOAD_FILE_PATH}?name=clip.mp4&delay=1500&body=CONCURRENT_TWO">Download concurrent 2</a>
    <a id="download-case-1" download="Report.zip" href="${DOWNLOAD_FILE_PATH}?name=Report.zip&delay=1500&body=CASE_UPPER">Download case 1</a>
    <a id="download-case-2" download="report.zip" href="${DOWNLOAD_FILE_PATH}?name=report.zip&delay=1500&body=CASE_LOWER">Download case 2</a>
    <a id="save-as-link" href="${DOWNLOAD_SAVE_AS_REDIRECT_PATH}">Save link target</a>
    <img id="save-as-image" src="${DOWNLOAD_IMAGE_PATH}" alt="Download fixture sample" />
    <a id="download-after-link-save-as" download="after-link-save-as.mp4" href="${DOWNLOAD_FILE_PATH}?name=after-link-save-as.mp4&body=AFTER_LINK_SAVE_AS_BYTES">Download after link</a>
    <a id="download-after-image-save-as" download="after-image-save-as.mp4" href="${DOWNLOAD_FILE_PATH}?name=after-image-save-as.mp4&body=AFTER_IMAGE_SAVE_AS_BYTES">Download after image</a>
    <a id="download-custom" download="custom.mp4" href="${DOWNLOAD_FILE_PATH}?name=custom.mp4&body=CUSTOM_DIR_BYTES">Download custom</a>
    <a id="download-retry-race" download="${RETRY_RACE_FILE}" href="${DOWNLOAD_FILE_PATH}?name=${RETRY_RACE_FILE}">Download during history retry</a>
    <a id="download-before-clear" download="${CLEAR_HISTORY_FILE}" href="${DOWNLOAD_FILE_PATH}?name=${CLEAR_HISTORY_FILE}&body=KEEP_THIS_FILE">Download before clearing history</a>
    <a id="download-after-missing-dir" download="after-missing-dir.mp4" href="${DOWNLOAD_FILE_PATH}?name=after-missing-dir.mp4&body=MISSING_DIR_BYTES">Download after missing dir</a>
    <a id="download-after-unwritable" download="after-unwritable.mp4" href="${DOWNLOAD_FILE_PATH}?name=after-unwritable.mp4&body=UNWRITABLE_DIR_BYTES">Download unwritable</a>
    <a id="download-recovered-default" download="recovered-default.mp4" href="${DOWNLOAD_FILE_PATH}?name=recovered-default.mp4&body=RECOVERED_DEFAULT_BYTES">Download recovered default</a>
    <a id="download-ask-mode" download="ask-mode.mp4" href="${DOWNLOAD_FILE_PATH}?name=ask-mode.mp4&body=ASK_MODE_BYTES">Download ask mode</a>
    <a id="download-after-ask-mode" download="after-ask-mode.mp4" href="${DOWNLOAD_FILE_PATH}?name=after-ask-mode.mp4&body=AFTER_ASK_MODE_BYTES">Download after ask mode</a>
  </body>
</html>`
}

export async function handleBrowserDownloadHttp(request, response, url) {
  if (request.method !== 'GET') return false
  if (url.pathname === DOWNLOAD_FIXTURE_PATH || url.pathname === DOWNLOAD_OAUTH_CALLBACK_PATH) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(downloadFixtureHtml())
    return true
  }
  if (url.pathname === DOWNLOAD_IMAGE_PATH) {
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(TEST_IMAGE_PNG.byteLength),
    })
    response.end(TEST_IMAGE_PNG)
    return true
  }
  if (url.pathname === DOWNLOAD_SAVE_AS_REDIRECT_PATH) {
    response.writeHead(302, {
      location: `${DOWNLOAD_FILE_PATH}?name=saved-link.mp4&body=SAVE_AS_LINK_BYTES`,
    })
    response.end()
    return true
  }
  if (url.pathname === DOWNLOAD_FILE_PATH) {
    const filename = url.searchParams.get('name') || 'download.bin'
    const gate = heldDownloadGates.get(filename)
    if (gate) {
      const payload = Buffer.from(HELD_DOWNLOAD_CONTENT)
      const offset = Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0)
      response.writeHead(offset ? 206 : 200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': payload.length - offset,
        'accept-ranges': 'bytes',
        etag: '"custom-download"',
        ...(offset
          ? { 'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}` }
          : {}),
      })
      const split = Math.max(offset, payload.length / 2)
      response.write(payload.subarray(offset, split))
      await gate
      if (!response.destroyed) response.end(payload.subarray(split))
      return true
    }
    const body = url.searchParams.get('body') || 'payload'
    const delayMs = Number(url.searchParams.get('delay') || '0')
    const payload = Buffer.from(body, 'utf8')
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(payload.byteLength),
    })
    response.flushHeaders()
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
    response.end(payload)
    return true
  }
  return false
}

async function waitForCondition(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const detail = lastError
    ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : ''
  throw new Error(`Timed out waiting for ${description}${detail}`)
}

async function waitForFileContent(filePath, expected, timeoutMs, description) {
  return waitForCondition(
    async () => {
      if (!existsSync(filePath)) return false
      const content = await readFile(filePath, 'utf8')
      return content === expected ? content : false
    },
    timeoutMs,
    description
  )
}

async function waitForFileBuffer(filePath, expectedBuffer, timeoutMs, description) {
  return waitForCondition(
    async () => {
      if (!existsSync(filePath)) return false
      const content = await readFile(filePath)
      return content.equals(expectedBuffer) ? content : false
    },
    timeoutMs,
    description
  )
}

async function clickDownloadLink(bridgeCall, selector) {
  const result = await bridgeCall({ action: 'click', selector, timeoutMs: 5_000 })
  assert.equal(
    result.ok,
    true,
    `Failed to click download link ${selector}: ${JSON.stringify(result)}`
  )
}

async function settleDownloadNotifications(control, fileNames, status = '已下载') {
  const visible = { visible: true, timeoutMs: 5_000 }
  // Keep the list open until all preceding downloads are terminal; their
  // completion events must not open another peek before the next native click.
  await control.command('click', DOWNLOAD_BUTTON)
  for (const fileName of fileNames) {
    const row = `${DOWNLOAD_PANEL} [data-file-name=${JSON.stringify(fileName)}]`
    await control.command('waitFor', `${row} [data-testid="workspace-browser-download-status"]`, {
      ...visible,
      text: status,
    })
  }
  await control.command(
    'click',
    `${DOWNLOAD_PANEL} [data-testid="workspace-browser-downloads-close"]`
  )
  await control.command('waitFor', DOWNLOAD_PANEL, { ...visible, visible: false })
  await control.command('waitFor', '[data-testid="workspace-browser-download-peek"]', {
    ...visible,
    visible: false,
  })
  const label = await control.command(
    'getAttribute',
    `${ACTIVE_WORKBENCH} [data-testid="workspace-browser-panel"]:not(.hidden)`,
    { value: 'data-embedded-browser-label' }
  )
  assert.ok(label, 'The active browser panel must have a native view label')
  const view = `[data-testid="workspace-browser-electron-webview"][data-wework-browser-webview=${JSON.stringify(label)}]`
  await waitForValue(
    async () => JSON.parse(await control.command('getElementMetrics', view)),
    metrics => metrics.length === 1 && metrics[0].hitTestVisible,
    'The guest must receive pointer input after dismissing download notifications',
    5_000
  )
}

async function verifyAddressHistory(control, bridgeCall, fixtureUrl) {
  const address = `${ACTIVE_WORKBENCH} [data-testid="workspace-browser-url-input"]`
  const verifyInvalidAddress = async (value, text) => {
    await control.command('fill', address, { value })
    // Fail before submitting if the proposed destination would be an external search.
    await control.command('waitFor', '[data-testid="workspace-browser-address-submit"]', {
      text: '打开网址',
      visible: true,
      timeoutMs: 5_000,
    })
    await control.command('submit', address)
    return control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH} [data-testid="workspace-browser-error"]`,
      {
        text,
        visible: true,
        timeoutMs: 5_000,
      }
    )
  }
  const invalidAddressMessage = await verifyInvalidAddress('10.0.0.999', '请输入有效的')
  const invalidPortMessage = await verifyInvalidAddress(
    '10.0.0.5 :84443/reports?token=sample',
    '端口'
  )
  const invalidSingleLabelPortMessage = await verifyInvalidAddress(
    '3d:bad/report?token=sample',
    '端口'
  )
  const invalidSchemeMessage = await verifyInvalidAddress(
    'https ://intranet.test/reports?token=sample',
    '请输入有效的'
  )
  const plainSearchTerms = ['2026', 'react@19.2.0']
  for (const term of plainSearchTerms) {
    await control.command('fill', address, { value: term })
    await control.command('waitFor', '[data-testid="workspace-browser-address-submit"]', {
      text: '搜索网页',
      visible: true,
      timeoutMs: 5_000,
    })
  }
  for (const query of [
    '?access_token=synthetic-history-fixture',
    '?reset_password_token=synthetic-history-fixture',
    '?sv=2024-11-04&sp=r&se=2030-01-01&sig=synthetic-history-fixture',
    `${DOWNLOAD_OAUTH_CALLBACK_PATH}?code=synthetic-history-fixture&state=opaque`,
    '#https://synthetic:synthetic-history-fixture@inner.test/login',
  ]) {
    const sensitiveUrl = new URL(query, fixtureUrl).href
    await control.command('submit', address, { value: sensitiveUrl })
    const loaded = await bridgeCall({
      action: 'waitFor',
      options: {
        condition: {
          expression: `location.href === ${JSON.stringify(sensitiveUrl)} && document.readyState === 'complete'`,
        },
      },
      timeoutMs: 5_000,
    })
    assert.equal(loaded.ok, true, 'A private URL must still be navigable')
  }
  const spacedHostMessage = await verifyInvalidAddress(
    'intra net.test/reports?token=sample',
    '请输入有效的'
  )
  const imageUrl = new URL(DOWNLOAD_IMAGE_PATH, fixtureUrl).href
  await control.command('submit', address, { value: imageUrl })
  const imagePage = await bridgeCall({
    action: 'waitFor',
    options: { condition: { expression: `location.href === ${JSON.stringify(imageUrl)}` } },
    timeoutMs: 5_000,
  })
  assert.equal(imagePage.ok, true, 'Address bar must leave the download fixture before recall')

  // This phrase occurs in the title but not the URL.
  await control.command('fill', address, { value: 'Download Policy' })
  const option = `[data-testid="workspace-browser-address-history-option"][data-url="${fixtureUrl}"]`
  await control.command('waitFor', option, {
    text: DOWNLOAD_FIXTURE_TITLE,
    visible: true,
    timeoutMs: 5_000,
  })
  const privateHistoryMatches = Number(
    await control.command(
      'getElementCount',
      '[data-testid="workspace-browser-address-history-option"][data-url*="synthetic-history-fixture"]'
    )
  )
  assert.equal(privateHistoryMatches, 0, 'Private visits must be absent from title-matched history')
  await control.command(
    'waitFor',
    '[data-testid="workspace-browser-address-submit"][data-highlighted]',
    {
      visible: true,
      timeoutMs: 5_000,
    }
  )
  // Send real key events to this renderer without taking the user's OS keyboard focus.
  await withProjectRenderer(async (client, target) => {
    const press = async (key, windowsVirtualKeyCode) => {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await client({
          action: 'command',
          target,
          method: 'Input.dispatchKeyEvent',
          params: { type, key, code: key, windowsVirtualKeyCode },
        })
      }
    }
    await press('ArrowDown', 40)
    await control.command('waitFor', `${option}[data-highlighted]`, {
      visible: true,
      timeoutMs: 5_000,
    })
    await press('Enter', 13)
  })
  const recalled = await bridgeCall({
    action: 'waitFor',
    options: {
      condition: {
        textVisible: DOWNLOAD_FIXTURE_TITLE,
        expression: `location.href === ${JSON.stringify(fixtureUrl)}`,
      },
    },
    timeoutMs: 5_000,
  })
  assert.equal(recalled.ok, true, 'Choosing history must load the original guest document')
  return {
    url: fixtureUrl,
    title: DOWNLOAD_FIXTURE_TITLE,
    invalidPortMessage,
    invalidSingleLabelPortMessage,
    invalidAddressMessage,
    invalidSchemeMessage,
    spacedHostMessage,
    plainSearchTerms,
    privateHistoryMatches,
  }
}

async function verifyRetryWithConcurrentDownload(control, db, fileName, releaseDownload) {
  const gates = runtimeTransportGates(control)
  const id = 'browser-download-history-retry'
  const visible = { visible: true, timeoutMs: 5_000 }
  const row = `${DOWNLOAD_PANEL} [data-testid="workspace-browser-download-item"][data-file-name="${RETRY_RACE_FILE}"]`
  const stored = name => db.prepare('SELECT id FROM downloads WHERE fileName = ?').all(name)
  await control.command('waitFor', DOWNLOAD_RETRY, { ...visible, enabled: true })
  await control.command(
    'waitFor',
    `${row} [data-testid="workspace-browser-download-progress"]`,
    visible
  )
  assert.equal(stored(fileName).length, 0, 'The first download must be pending before retry')

  await gates.arm({ id, kind: 'response', name: 'browser.listDownloads' })
  try {
    db.exec('ROLLBACK')
    await control.command('click', DOWNLOAD_RETRY)
    const { value, deliveries } = await gates.wait(id, undefined, 5_000)
    assert.equal(deliveries, 0, 'The renderer must still be waiting for the real retry response')
    assert.equal(value.result.historyUnavailable, false)
    assert.ok(
      value.result.downloads.some(
        record =>
          record.fileName === RETRY_RACE_FILE && ['started', 'progress'].includes(record.status)
      ),
      'The retry response must predate the second download completing'
    )
    assert.equal(stored(fileName).length, 1, 'The retry must commit the first download once')

    db.exec('BEGIN EXCLUSIVE')
    releaseDownload()
    const status = `${row} [data-testid="workspace-browser-download-status"]`
    await control.command('waitFor', status, { ...visible, text: '已下载' })
    assert.equal(stored(RETRY_RACE_FILE).length, 0, 'The newer download must fail to write')
    await gates.release(id)
    // Retry is disabled while the response is held. Its enabled state proves the stale reply was applied.
    const retried = await control.command('waitFor', DOWNLOAD_RETRY, { ...visible, enabled: true })
    await control.command('waitFor', status, { ...visible, text: '已下载' })

    await control.command('click', DOWNLOAD_BUTTON)
    await control.command('waitFor', DOWNLOAD_PANEL, { ...visible, visible: false })
    await control.command('click', DOWNLOAD_BUTTON)
    await control.command('waitFor', DOWNLOAD_RETRY, { ...visible, enabled: true })
    const cached = `${DOWNLOAD_PANEL} [data-testid="workspace-browser-download-item"][data-file-name="${fileName}"]`
    await control.command(
      'waitFor',
      `${cached} [data-testid="workspace-browser-download-status"]`,
      {
        ...visible,
        text: '已下载',
      }
    )

    db.exec('ROLLBACK')
    await control.command('click', DOWNLOAD_RETRY)
    await control.command('waitFor', DOWNLOAD_RETRY, { ...visible, visible: false })
    assert.equal(
      stored(RETRY_RACE_FILE).length,
      1,
      'The next retry must save the newer download once'
    )
    await control.command('click', `${row} [data-testid="workspace-browser-download-more-button"]`)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="workspace-browser-download-remove-record"]',
      {
        timeoutMs: 5_000,
      }
    )
    await control.command('waitFor', row, { ...visible, visible: false })
    return retried
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
    await gates.reset()
  }
}

async function verifyDownloadList(
  control,
  downloadsPath,
  fileName,
  content,
  {
    lockedHistory,
    releaseConcurrentDownload,
    restartBrowser,
    sizeLabel = `${Buffer.byteLength(content)} B`,
  } = {}
) {
  const item = `${DOWNLOAD_PANEL} [data-testid="workspace-browser-download-item"]`
  const row = `${item}[data-file-name="${fileName}"]`
  const reveal = '[data-testid="workspace-browser-download-reveal-button"]'
  const status = '[data-testid="workspace-browser-download-status"]'
  const visible = { visible: true, timeoutMs: 5_000 }
  await control.command('waitFor', '[data-testid="workspace-browser-download-peek"]', {
    ...visible,
    text: fileName,
  })
  await control.command('waitFor', '[data-testid="workspace-browser-download-peek-open"]', {
    ...visible,
    enabled: true,
  })
  await control.command(
    'waitFor',
    '[data-testid="workspace-browser-download-peek-show-in-folder"]',
    { ...visible, enabled: true }
  )
  await control.command('click', DOWNLOAD_BUTTON)
  const metadata = await control.command('waitFor', `${row} ${status}`, {
    ...visible,
    text: sizeLabel,
  })
  assert.match(metadata, /\d{1,2}:\d{2}/, 'The completed row must display the download time')
  await control.command('waitFor', `${row} ${reveal}`, { ...visible, enabled: true })
  let metadataAfterRestart
  let retryAfterStaleReply
  if (lockedHistory) {
    retryAfterStaleReply = await verifyRetryWithConcurrentDownload(
      control,
      lockedHistory,
      fileName,
      releaseConcurrentDownload
    )
    await restartBrowser()
    await control.command('clickWhenEnabled', DOWNLOAD_BUTTON, { timeoutMs: 5_000 })
    metadataAfterRestart = await control.command('waitFor', `${row} ${status}`, {
      ...visible,
      text: sizeLabel,
    })
    assert.equal(
      metadataAfterRestart,
      metadata,
      'The restarted host must recover the same download'
    )
  }
  await control.command('click', DOWNLOAD_BUTTON)
  await control.command('waitFor', DOWNLOAD_PANEL, { visible: false, timeoutMs: 5_000 })

  const path = join(downloadsPath, fileName)
  const moved = join(downloadsPath, `moved-${fileName}`)
  await rename(path, moved)
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH} [data-testid="workspace-browser-more-button"]`
  )
  const menuItem = '[data-testid="workspace-browser-downloads-item"]'
  await control.command('waitFor', menuItem, { ...visible, enabled: true })
  await control.command('click', menuItem)
  const missing = `${row}[data-file-missing="true"]`
  const missingStatus = await control.command('waitFor', `${missing} ${status}`, {
    ...visible,
    text: '文件已移动或删除',
  })
  await control.command('waitFor', `${missing} ${reveal}:disabled`, visible)

  await control.command('click', DOWNLOAD_BUTTON)
  await control.command('waitFor', DOWNLOAD_PANEL, { visible: false, timeoutMs: 5_000 })
  await rename(moved, path)
  await control.command('click', DOWNLOAD_BUTTON)
  await control.command('waitFor', `${row}[data-file-missing="false"] ${reveal}`, {
    ...visible,
    enabled: true,
  })
  await control.command('click', `${row} [data-testid="workspace-browser-download-more-button"]`)
  const remove = '[data-testid="workspace-browser-download-remove-record"]'
  await control.command('waitFor', remove, { ...visible, enabled: true })
  await control.command('click', remove)
  await control.command('waitFor', `${DOWNLOAD_PANEL} [role="status"]`, {
    ...visible,
    text: '暂无下载内容',
  })
  const rowCountAfterRemoval = Number(await control.command('getElementCount', row))
  assert.equal(rowCountAfterRemoval, 0, 'Removed download is still listed')
  const bytes = await readFile(path)
  assert.equal(bytes.toString('utf8'), content)
  await control.command('click', DOWNLOAD_BUTTON)
  await control.command('waitFor', DOWNLOAD_PANEL, { visible: false, timeoutMs: 5_000 })
  return {
    fileName,
    metadata,
    retryAfterStaleReply,
    metadataAfterRestart,
    missingStatus,
    rowCountAfterRemoval,
    bytesOnDisk: bytes.byteLength,
  }
}

async function verifyClearBrowserData(control, db, historyPath, fixtureUrl, downloadsPath) {
  const visible = { visible: true, timeoutMs: 5_000 }
  const status = '[data-testid="browser-settings-status"]'
  const confirm = '[data-testid="browser-clear-data-confirm"]'
  const downloadCount = () => db.prepare('SELECT COUNT(*) AS count FROM downloads').get().count
  const history = async () => JSON.parse(await readFile(historyPath, 'utf8'))
  await settleDownloadNotifications(control, [CLEAR_HISTORY_FILE])
  assert.equal(downloadCount(), 1, 'A real completed download must be stored before clearing')
  assert.ok((await history()).some(entry => entry.url === fixtureUrl))

  await control.command('click', '[data-testid="settings-button"]')
  await control.command('click', '[data-testid="settings-menu-button"]')
  await control.command('click', '[data-testid="settings-nav-browser"]')
  await control.command('clickWhenEnabled', '[data-testid="browser-clear-data-button"]', visible)

  let failedMessage
  db.exec('BEGIN EXCLUSIVE')
  try {
    await control.command('clickWhenEnabled', confirm, visible)
    failedMessage = await control.command('waitFor', status, {
      ...visible,
      text: '无法清除内置浏览器数据',
    })
    assert.ok(
      (await history()).some(entry => entry.url === fixtureUrl),
      'A locked download database must not cause browser history to be cleared'
    )
  } finally {
    db.exec('ROLLBACK')
  }
  assert.equal(downloadCount(), 1, 'A failed clear must preserve the stored download')

  await control.command('clickWhenEnabled', confirm, visible)
  const successMessage = await control.command('waitFor', status, {
    ...visible,
    text: '内置浏览器数据已清除',
  })
  assert.deepEqual(await history(), [])
  assert.equal(downloadCount(), 0)
  assert.equal(await readFile(join(downloadsPath, CLEAR_HISTORY_FILE), 'utf8'), 'KEEP_THIS_FILE')
  await control.command('click', '[data-testid="settings-back-button"]')
  await control.command('waitFor', DOWNLOAD_BUTTON, visible)
  return { failedMessage, successMessage, fileRetained: true }
}

export async function verifyBrowserDownloadHistory({
  bridgeCall,
  restartBrowser,
  control,
  downloadsPath,
  electronUserDataDirectory,
  uiTimeoutMs,
}) {
  await mkdir(downloadsPath, { recursive: true })
  const fixtureUrl = `${control.url}${DOWNLOAD_FIXTURE_PATH}?ticket=1234&code=404&state=open&filter=name%26signature%3Ddraft`
  await control.command('setAppPreferences', 'body', {
    value: JSON.stringify({
      language: 'zh-CN',
      browserDownloadDirectory: null,
      browserAskBeforeDownload: false,
    }),
  })
  const openResult = await bridgeCall({ action: 'open', url: fixtureUrl, timeoutMs: 8_000 })
  assert.equal(
    openResult.ok,
    true,
    `Download fixture failed to open: ${JSON.stringify(openResult)}`
  )
  const waitResult = await bridgeCall({
    action: 'waitFor',
    options: { condition: { textVisible: DOWNLOAD_FIXTURE_TITLE } },
    timeoutMs: 5_000,
  })
  assert.equal(waitResult.ok, true, 'Download fixture did not render')
  await control.command('click', DOWNLOAD_BUTTON)
  const emptyList = await control.command('waitFor', `${DOWNLOAD_PANEL} [role="status"]`, {
    visible: true,
    text: '暂无下载内容',
    timeoutMs: 5_000,
  })
  await control.command('click', DOWNLOAD_BUTTON)
  await control.command('waitFor', DOWNLOAD_PANEL, { visible: false, timeoutMs: 5_000 })
  const history = await verifyAddressHistory(control, bridgeCall, fixtureUrl)

  // The native save-dialog checks also use this file to exercise name collisions.
  await clickDownloadLink(bridgeCall, '#download-single')
  await waitForFileContent(
    join(downloadsPath, 'clip.mp4'),
    'SINGLE_CLIP_BYTES',
    uiTimeoutMs,
    'direct embedded-browser download clip.mp4'
  )
  await assertNoNativeSaveDialog(control.applicationProcessId)
  const download = await verifyDownloadList(control, downloadsPath, 'clip.mp4', 'SINGLE_CLIP_BYTES')

  const db = new DatabaseSync(join(electronUserDataDirectory, 'browser-download-history.sqlite'))
  const fileName = 'custom.mp4'
  const gate = Promise.withResolvers()
  const concurrentGate = Promise.withResolvers()
  heldDownloadGates.set(fileName, gate.promise)
  heldDownloadGates.set(RETRY_RACE_FILE, concurrentGate.promise)
  try {
    await clickDownloadLink(bridgeCall, '#download-custom')
    const visible = { visible: true, timeoutMs: 5_000 }
    const row = `${DOWNLOAD_PANEL} [data-testid="workspace-browser-download-item"][data-file-name="${fileName}"]`
    const pause = `${row} [data-testid="workspace-browser-download-pause-button"]`
    const resume = `${row} [data-testid="workspace-browser-download-resume-button"]`
    await control.command('click', DOWNLOAD_BUTTON)
    await control.command('clickWhenEnabled', pause, { timeoutMs: 5_000 })
    await control.command('waitFor', resume, visible)
    await control.command('click', DOWNLOAD_BUTTON)
    await control.command('waitFor', DOWNLOAD_PANEL, { visible: false, timeoutMs: 5_000 })

    // A fresh, blank tab has no cached events from the download's owning tab.
    const selectedTab =
      '[role="tab"][data-testid^="right-workspace-browser-tab-"][aria-selected="true"]'
    const owner = await control.command('getAttribute', selectedTab, { value: 'data-testid' })
    await control.command('click', '[data-testid="right-workspace-new-tab-button"]')
    await control.command('clickWhenEnabled', '[data-testid="right-workspace-browser-option"]', {
      timeoutMs: 5_000,
    })
    const freshTab = `${selectedTab}:not([data-testid="${owner}"])`
    await control.command('waitFor', freshTab, visible)
    db.exec('BEGIN EXCLUSIVE')
    await control.command(
      'click',
      `${ACTIVE_WORKBENCH} [data-testid="workspace-browser-panel"]:not(.hidden) [data-testid="workspace-browser-downloads-button"]`
    )
    await control.command(
      'waitFor',
      `${DOWNLOAD_PANEL} [data-testid="workspace-browser-downloads-retry"]`,
      visible
    )
    await control.command('clickWhenEnabled', resume, { timeoutMs: 5_000 })
    await control.command('waitFor', pause, visible)
    await control.command(
      'click',
      `${DOWNLOAD_PANEL} [data-testid="workspace-browser-downloads-close"]`
    )
    await control.command('click', `${freshTab} [data-testid$="-close-button"]`)
    await control.command('waitFor', `[data-testid="${owner}"][aria-selected="true"]`, visible)
    await clickDownloadLink(bridgeCall, '#download-retry-race')
    gate.resolve()
    const sessionDownload = await verifyDownloadList(
      control,
      downloadsPath,
      fileName,
      HELD_DOWNLOAD_CONTENT,
      {
        lockedHistory: db,
        releaseConcurrentDownload: concurrentGate.resolve,
        sizeLabel: '4.0 KB',
        restartBrowser: () => restartBrowser(fixtureUrl),
      }
    )
    await clickDownloadLink(bridgeCall, '#download-before-clear')
    const clearing = await verifyClearBrowserData(
      control,
      db,
      join(electronUserDataDirectory, 'browser-history.json'),
      fixtureUrl,
      downloadsPath
    )
    return { emptyList, history, download, sessionDownload, clearing }
  } finally {
    gate.resolve()
    concurrentGate.resolve()
    heldDownloadGates.delete(fileName)
    heldDownloadGates.delete(RETRY_RACE_FILE)
    db.close()
  }
}

export async function verifyBrowserDownloadPolicy({
  bridgeCall,
  restartBrowser,
  control,
  downloadsPath,
  electronUserDataDirectory,
  resultDir,
  uiTimeoutMs,
}) {
  const chosenDir = join(resultDir, 'user-chosen-downloads')
  const customDownloadsDir = join(resultDir, 'custom-downloads')
  const blockingFile = join(resultDir, 'unwritable-download-parent')
  const unwritableCustomDir = join(blockingFile, 'nested-downloads')
  await mkdir(chosenDir, { recursive: true })

  try {
    await verifyBrowserDownloadHistory({
      bridgeCall,
      restartBrowser,
      control,
      downloadsPath,
      electronUserDataDirectory,
      uiTimeoutMs,
    })
    const pid = control.applicationProcessId
    await assertNoNativeSaveDialog(pid)

    // 2. Concurrent duplicate downloads write distinct collision-free files.
    await clickDownloadLink(bridgeCall, '#download-concurrent-1')
    await clickDownloadLink(bridgeCall, '#download-concurrent-2')
    const concurrentContents = await waitForCondition(
      async () => {
        const firstPath = join(downloadsPath, 'clip (1).mp4')
        const secondPath = join(downloadsPath, 'clip (2).mp4')
        if (!existsSync(firstPath) || !existsSync(secondPath)) return null
        const [first, second] = await Promise.all([
          readFile(firstPath, 'utf8'),
          readFile(secondPath, 'utf8'),
        ])
        const sorted = [first, second].sort()
        return sorted[0] === 'CONCURRENT_ONE' && sorted[1] === 'CONCURRENT_TWO' ? sorted : null
      },
      uiTimeoutMs,
      'concurrent duplicate downloads clip (1).mp4 and clip (2).mp4'
    )
    assert.deepEqual(concurrentContents, ['CONCURRENT_ONE', 'CONCURRENT_TWO'])
    assert.equal(await readFile(join(downloadsPath, 'clip.mp4'), 'utf8'), 'SINGLE_CLIP_BYTES')

    // Concurrent case-variant downloads preserve both payloads without collision.
    await clickDownloadLink(bridgeCall, '#download-case-1')
    await clickDownloadLink(bridgeCall, '#download-case-2')
    const caseVariantDownloads = await waitForCondition(
      async () => {
        const entries = (await readdir(downloadsPath)).filter(name =>
          /^report(?: \(1\))?\.zip$/i.test(name)
        )
        if (entries.length < 2) return null
        const contents = await Promise.all(
          entries.map(name => readFile(join(downloadsPath, name), 'utf8'))
        )
        const sorted = contents.sort()
        return sorted[0] === 'CASE_LOWER' && sorted[1] === 'CASE_UPPER'
          ? { entries, contents: sorted }
          : null
      },
      uiTimeoutMs,
      'concurrent case-variant downloads Report.zip and report.zip'
    )
    assert.deepEqual(caseVariantDownloads.contents, ['CASE_LOWER', 'CASE_UPPER'])

    // 3. Main window (session.defaultSession) blob download saves directly without prompting.
    await control.command('triggerBlobDownload', 'body', {
      value: JSON.stringify({
        filename: 'main-video.mp4',
        content: 'MAIN_WINDOW_VIDEO_BYTES',
      }),
    })
    await waitForFileContent(
      join(downloadsPath, 'main-video.mp4'),
      'MAIN_WINDOW_VIDEO_BYTES',
      uiTimeoutMs,
      'main window direct download main-video.mp4'
    )
    await assertNoNativeSaveDialog(pid)

    // 4. Real link right-click menu ("Save Link As...") with HTTP 302 redirect:
    //    cancel once, save to user-chosen location, then verify subsequent direct save recovers.
    await settleDownloadNotifications(control, [
      'clip (1).mp4',
      'clip (2).mp4',
      ...caseVariantDownloads.entries,
    ])
    await withNativeSaveDialog(
      control,
      () =>
        triggerEmbeddedBrowserContextMenuItem({
          bridgeCall,
          control,
          downCount: LINK_SAVE_AS_MENU_DOWN_COUNT,
          windowsMenuLabels: ['Save Link As...', '链接存储为...'],
          resultDir,
          stepName: 'link-save-as-cancel',
          targetSelector: '#save-as-link',
          timeoutMs: uiTimeoutMs,
        }),
      { action: 'cancel', resultDir, stepName: 'link-save-as-cancel', timeoutMs: uiTimeoutMs }
    )
    assert.equal(existsSync(join(downloadsPath, 'saved-link.mp4')), false)
    await settleDownloadNotifications(control, ['saved-link.mp4'], '下载失败')

    const chosenLinkPath = join(chosenDir, 'chosen-link.mp4')
    await withNativeSaveDialog(
      control,
      () =>
        triggerEmbeddedBrowserContextMenuItem({
          bridgeCall,
          control,
          downCount: LINK_SAVE_AS_MENU_DOWN_COUNT,
          windowsMenuLabels: ['Save Link As...', '链接存储为...'],
          resultDir,
          stepName: 'link-save-as-choose',
          targetSelector: '#save-as-link',
          timeoutMs: uiTimeoutMs,
        }),
      {
        action: 'save',
        savePath: chosenLinkPath,
        resultDir,
        stepName: 'link-save-as-choose',
        timeoutMs: uiTimeoutMs,
      }
    )
    await waitForFileContent(
      chosenLinkPath,
      'SAVE_AS_LINK_BYTES',
      uiTimeoutMs,
      'Save Link As file written to user-chosen location'
    )
    assert.equal(existsSync(join(downloadsPath, 'saved-link.mp4')), false)

    await clickDownloadLink(bridgeCall, '#download-after-link-save-as')
    await waitForFileContent(
      join(downloadsPath, 'after-link-save-as.mp4'),
      'AFTER_LINK_SAVE_AS_BYTES',
      uiTimeoutMs,
      'direct download recovery after Save Link As'
    )
    await assertNoNativeSaveDialog(pid)

    // 5. Real image right-click menu ("Save Image As..."):
    //    cancel once, save to user-chosen location, then verify subsequent direct save recovers.
    await settleDownloadNotifications(control, ['chosen-link.mp4', 'after-link-save-as.mp4'])
    await withNativeSaveDialog(
      control,
      () =>
        triggerEmbeddedBrowserContextMenuItem({
          bridgeCall,
          control,
          downCount: IMAGE_SAVE_AS_MENU_DOWN_COUNT,
          windowsMenuLabels: ['Save Image As...', '图片存储为...'],
          resultDir,
          stepName: 'image-save-as-cancel',
          targetSelector: '#save-as-image',
          timeoutMs: uiTimeoutMs,
        }),
      { action: 'cancel', resultDir, stepName: 'image-save-as-cancel', timeoutMs: uiTimeoutMs }
    )
    assert.equal(existsSync(join(downloadsPath, 'embedded-browser-download-image.png')), false)
    await settleDownloadNotifications(control, ['embedded-browser-download-image.png'], '下载失败')

    const chosenImagePath = join(chosenDir, 'chosen-image.png')
    await withNativeSaveDialog(
      control,
      () =>
        triggerEmbeddedBrowserContextMenuItem({
          bridgeCall,
          control,
          downCount: IMAGE_SAVE_AS_MENU_DOWN_COUNT,
          windowsMenuLabels: ['Save Image As...', '图片存储为...'],
          resultDir,
          stepName: 'image-save-as-choose',
          targetSelector: '#save-as-image',
          timeoutMs: uiTimeoutMs,
        }),
      {
        action: 'save',
        savePath: chosenImagePath,
        resultDir,
        stepName: 'image-save-as-choose',
        timeoutMs: uiTimeoutMs,
      }
    )
    await waitForFileBuffer(
      chosenImagePath,
      TEST_IMAGE_PNG,
      uiTimeoutMs,
      'Save Image As file written to user-chosen location'
    )
    assert.equal(existsSync(join(downloadsPath, 'embedded-browser-download-image.png')), false)

    await clickDownloadLink(bridgeCall, '#download-after-image-save-as')
    await waitForFileContent(
      join(downloadsPath, 'after-image-save-as.mp4'),
      'AFTER_IMAGE_SAVE_AS_BYTES',
      uiTimeoutMs,
      'direct download recovery after Save Image As'
    )
    await assertNoNativeSaveDialog(pid)

    // 6. Custom directory saves directly; runtime deletion opens real Save As (cancel + choose) without silent fallback.
    await mkdir(customDownloadsDir, { recursive: true })
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        browserDownloadDirectory: customDownloadsDir,
        browserAskBeforeDownload: false,
      }),
    })
    await clickDownloadLink(bridgeCall, '#download-custom')
    await waitForFileContent(
      join(customDownloadsDir, 'custom.mp4'),
      'CUSTOM_DIR_BYTES',
      uiTimeoutMs,
      'custom directory download custom.mp4'
    )
    await assertNoNativeSaveDialog(pid)

    await rm(customDownloadsDir, { recursive: true, force: true })
    await withNativeSaveDialog(
      control,
      () => clickDownloadLink(bridgeCall, '#download-after-missing-dir'),
      { action: 'cancel', resultDir, stepName: 'missing-dir-cancel', timeoutMs: uiTimeoutMs }
    )
    assert.equal(existsSync(join(downloadsPath, 'after-missing-dir.mp4')), false)
    assert.equal(existsSync(customDownloadsDir), false)

    const chosenAfterMissingPath = join(chosenDir, 'after-missing-dir-chosen.mp4')
    await withNativeSaveDialog(
      control,
      () => clickDownloadLink(bridgeCall, '#download-after-missing-dir'),
      {
        action: 'save',
        savePath: chosenAfterMissingPath,
        resultDir,
        stepName: 'missing-dir-choose',
        timeoutMs: uiTimeoutMs,
      }
    )
    await waitForFileContent(
      chosenAfterMissingPath,
      'MISSING_DIR_BYTES',
      uiTimeoutMs,
      'download saved to chosen location after custom directory was removed'
    )
    assert.equal(existsSync(join(downloadsPath, 'after-missing-dir.mp4')), false)
    assert.equal(existsSync(customDownloadsDir), false)

    // 7. Unwritable custom directory opens real Save As (cancel + choose), then recovers when reset to default.
    await writeFile(blockingFile, 'not a directory', 'utf8')
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        browserDownloadDirectory: unwritableCustomDir,
        browserAskBeforeDownload: false,
      }),
    })
    await withNativeSaveDialog(
      control,
      () => clickDownloadLink(bridgeCall, '#download-after-unwritable'),
      { action: 'cancel', resultDir, stepName: 'unwritable-dir-cancel', timeoutMs: uiTimeoutMs }
    )
    assert.equal(existsSync(join(downloadsPath, 'after-unwritable.mp4')), false)

    const chosenUnwritablePath = join(chosenDir, 'unwritable-dir-chosen.mp4')
    await withNativeSaveDialog(
      control,
      () => clickDownloadLink(bridgeCall, '#download-after-unwritable'),
      {
        action: 'save',
        savePath: chosenUnwritablePath,
        resultDir,
        stepName: 'unwritable-dir-choose',
        timeoutMs: uiTimeoutMs,
      }
    )
    await waitForFileContent(
      chosenUnwritablePath,
      'UNWRITABLE_DIR_BYTES',
      uiTimeoutMs,
      'download saved to chosen location when custom directory is unwritable'
    )
    assert.equal(existsSync(join(downloadsPath, 'after-unwritable.mp4')), false)

    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        browserDownloadDirectory: null,
        browserAskBeforeDownload: false,
      }),
    })
    await clickDownloadLink(bridgeCall, '#download-recovered-default')
    await waitForFileContent(
      join(downloadsPath, 'recovered-default.mp4'),
      'RECOVERED_DEFAULT_BYTES',
      uiTimeoutMs,
      'direct download recovery after clearing unwritable custom directory'
    )
    await assertNoNativeSaveDialog(pid)

    // 8. Ask-before-download opens real Save As (cancel + choose), then recovers to direct save when disabled.
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        browserDownloadDirectory: null,
        browserAskBeforeDownload: true,
      }),
    })
    await withNativeSaveDialog(control, () => clickDownloadLink(bridgeCall, '#download-ask-mode'), {
      action: 'cancel',
      resultDir,
      stepName: 'ask-mode-cancel',
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(existsSync(join(downloadsPath, 'ask-mode.mp4')), false)

    const chosenAskModePath = join(chosenDir, 'ask-mode-chosen.mp4')
    await withNativeSaveDialog(control, () => clickDownloadLink(bridgeCall, '#download-ask-mode'), {
      action: 'save',
      savePath: chosenAskModePath,
      resultDir,
      stepName: 'ask-mode-choose',
      timeoutMs: uiTimeoutMs,
    })
    await waitForFileContent(
      chosenAskModePath,
      'ASK_MODE_BYTES',
      uiTimeoutMs,
      'download saved to chosen location when browserAskBeforeDownload is enabled'
    )
    assert.equal(existsSync(join(downloadsPath, 'ask-mode.mp4')), false)

    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        browserDownloadDirectory: null,
        browserAskBeforeDownload: false,
      }),
    })
    await clickDownloadLink(bridgeCall, '#download-after-ask-mode')
    await waitForFileContent(
      join(downloadsPath, 'after-ask-mode.mp4'),
      'AFTER_ASK_MODE_BYTES',
      uiTimeoutMs,
      'direct download recovery after disabling browserAskBeforeDownload'
    )
    await assertNoNativeSaveDialog(pid)
  } finally {
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        browserDownloadDirectory: null,
        browserAskBeforeDownload: false,
      }),
    })
  }
}
