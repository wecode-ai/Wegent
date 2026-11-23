import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DOWNLOAD_FIXTURE_PATH = '/embedded-browser-download-fixture'
const DOWNLOAD_FILE_PATH = '/embedded-browser-download-file'
const DOWNLOAD_SAVE_AS_REDIRECT_PATH = '/embedded-browser-download-save-as-redirect'
const DOWNLOAD_FIXTURE_TITLE = 'Embedded Browser Download Policy Fixture'

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
        gap: 4px;
        margin: 0;
        padding: 12px;
        font: 13px/1.4 sans-serif;
      }
      h1 {
        margin: 0 0 4px;
        font-size: 16px;
      }
      a {
        display: inline-block;
        white-space: nowrap;
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
    <a id="download-custom" download="custom.mp4" href="${DOWNLOAD_FILE_PATH}?name=custom.mp4&body=CUSTOM_DIR_BYTES">Download custom</a>
    <a id="download-after-missing-dir" download="after-missing-dir.mp4" href="${DOWNLOAD_FILE_PATH}?name=after-missing-dir.mp4&body=SHOULD_PROMPT_MISSING_DIR">Download after missing dir</a>
    <a id="download-after-unwritable" download="after-unwritable.mp4" href="${DOWNLOAD_FILE_PATH}?name=after-unwritable.mp4&body=SHOULD_PROMPT_UNWRITABLE">Download unwritable</a>
    <a id="download-ask-mode" download="ask-mode.mp4" href="${DOWNLOAD_FILE_PATH}?name=ask-mode.mp4&body=ASK_MODE_BYTES">Download ask mode</a>
  </body>
</html>`
}

export async function handleBrowserDownloadHttp(request, response, url) {
  if (request.method !== 'GET') return false
  if (url.pathname === DOWNLOAD_FIXTURE_PATH) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(downloadFixtureHtml())
    return true
  }
  if (url.pathname === DOWNLOAD_SAVE_AS_REDIRECT_PATH) {
    response.writeHead(302, {
      location: `${DOWNLOAD_FILE_PATH}?name=saved-via-menu.mp4&body=SAVE_AS_REDIRECT`,
    })
    response.end()
    return true
  }
  if (url.pathname === DOWNLOAD_FILE_PATH) {
    const filename = url.searchParams.get('name') || 'download.bin'
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

async function readSaveDialogLog(logPath) {
  if (!existsSync(logPath)) return []
  const raw = await readFile(logPath, 'utf8')
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

async function waitForSaveDialogEvent(logPath, previousCount, timeoutMs, description) {
  return waitForCondition(
    async () => {
      const events = await readSaveDialogLog(logPath)
      return events.length > previousCount ? events[previousCount] : null
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

export async function verifyBrowserDownloadPolicy({
  bridgeCall,
  browserLabel,
  control,
  downloadsPath,
  resultDir,
  saveDialogLogPath,
  uiTimeoutMs,
}) {
  await mkdir(downloadsPath, { recursive: true })
  const fixtureUrl = `${control.url}${DOWNLOAD_FIXTURE_PATH}`
  const saveAsRedirectUrl = `${control.url}${DOWNLOAD_SAVE_AS_REDIRECT_PATH}`
  const customDownloadsDir = join(resultDir, 'custom-downloads')
  const blockingFile = join(resultDir, 'unwritable-download-parent')
  const unwritableCustomDir = join(blockingFile, 'nested-downloads')

  try {
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
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

    // 1. Direct download to system Downloads directory with no save dialog.
    await clickDownloadLink(bridgeCall, '#download-single')
    await waitForFileContent(
      join(downloadsPath, 'clip.mp4'),
      'SINGLE_CLIP_BYTES',
      uiTimeoutMs,
      'direct embedded-browser download clip.mp4'
    )
    assert.deepEqual(
      await readSaveDialogLog(saveDialogLogPath),
      [],
      'Direct download unexpectedly triggered a save dialog'
    )

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
    const caseVariantContents = await waitForCondition(
      async () => {
        const entries = (await readdir(downloadsPath)).filter(name =>
          /^report(?: \(1\))?\.zip$/i.test(name)
        )
        if (entries.length < 2) return null
        const contents = await Promise.all(
          entries.map(name => readFile(join(downloadsPath, name), 'utf8'))
        )
        const sorted = contents.sort()
        return sorted[0] === 'CASE_LOWER' && sorted[1] === 'CASE_UPPER' ? sorted : null
      },
      uiTimeoutMs,
      'concurrent case-variant downloads Report.zip and report.zip'
    )
    assert.deepEqual(caseVariantContents, ['CASE_LOWER', 'CASE_UPPER'])

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
    assert.deepEqual(
      await readSaveDialogLog(saveDialogLogPath),
      [],
      'Main window download unexpectedly triggered a save dialog'
    )

    // 4. Explicit one-shot Save As (including HTTP 302 redirect) prompts once, then returns to direct save.
    const countBeforeSaveAs = (await readSaveDialogLog(saveDialogLogPath)).length
    await control.command('saveEmbeddedBrowserUrlAs', 'body', {
      value: JSON.stringify({ label: browserLabel, url: saveAsRedirectUrl }),
    })
    const saveAsEvent = await waitForSaveDialogEvent(
      saveDialogLogPath,
      countBeforeSaveAs,
      uiTimeoutMs,
      'one-shot Save As dialog request'
    )
    assert.equal(saveAsEvent.reason, 'save-as')
    assert.equal(saveAsEvent.savePath, '')
    assert.equal(saveAsEvent.defaultPath, join(downloadsPath, 'saved-via-menu.mp4'))
    assert.equal(existsSync(join(downloadsPath, 'saved-via-menu.mp4')), false)

    await clickDownloadLink(bridgeCall, '#download-custom')
    await waitForFileContent(
      join(downloadsPath, 'custom.mp4'),
      'CUSTOM_DIR_BYTES',
      uiTimeoutMs,
      'direct download after one-shot Save As'
    )

    // 5. Custom download directory saves directly, then runtime deletion triggers Save As without silent fallback.
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

    await rm(customDownloadsDir, { recursive: true, force: true })
    const countBeforeMissingDirPrompt = (await readSaveDialogLog(saveDialogLogPath)).length
    await clickDownloadLink(bridgeCall, '#download-after-missing-dir')
    const afterMissingDirEvent = await waitForSaveDialogEvent(
      saveDialogLogPath,
      countBeforeMissingDirPrompt,
      uiTimeoutMs,
      'save dialog after custom download directory was removed at runtime'
    )
    assert.equal(afterMissingDirEvent.reason, 'directory-unavailable')
    assert.equal(afterMissingDirEvent.savePath, '')
    assert.equal(afterMissingDirEvent.filename, 'after-missing-dir.mp4')
    assert.equal(existsSync(join(downloadsPath, 'after-missing-dir.mp4')), false)
    assert.equal(existsSync(customDownloadsDir), false)

    // 6. Unwritable custom directory from the start prompts Save As instead of silently saving to system Downloads.
    await writeFile(blockingFile, 'not a directory', 'utf8')
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        browserDownloadDirectory: unwritableCustomDir,
        browserAskBeforeDownload: false,
      }),
    })
    const countBeforeUnwritablePrompt = (await readSaveDialogLog(saveDialogLogPath)).length
    await clickDownloadLink(bridgeCall, '#download-after-unwritable')
    const unwritableEvent = await waitForSaveDialogEvent(
      saveDialogLogPath,
      countBeforeUnwritablePrompt,
      uiTimeoutMs,
      'save dialog for unwritable custom download directory'
    )
    assert.equal(unwritableEvent.reason, 'directory-unavailable')
    assert.equal(unwritableEvent.savePath, '')
    assert.equal(unwritableEvent.filename, 'after-unwritable.mp4')
    assert.equal(existsSync(join(downloadsPath, 'after-unwritable.mp4')), false)

    // 7. Ask-before-download preference prompts Save As for every download.
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        browserDownloadDirectory: null,
        browserAskBeforeDownload: true,
      }),
    })
    const countBeforeAskMode = (await readSaveDialogLog(saveDialogLogPath)).length
    await clickDownloadLink(bridgeCall, '#download-ask-mode')
    const askModeEvent = await waitForSaveDialogEvent(
      saveDialogLogPath,
      countBeforeAskMode,
      uiTimeoutMs,
      'save dialog when browserAskBeforeDownload is enabled'
    )
    assert.equal(askModeEvent.reason, 'ask-before-download')
    assert.equal(askModeEvent.savePath, '')
    assert.equal(askModeEvent.defaultPath, join(downloadsPath, 'ask-mode.mp4'))
    assert.equal(existsSync(join(downloadsPath, 'ask-mode.mp4')), false)
  } finally {
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        browserDownloadDirectory: null,
        browserAskBeforeDownload: false,
      }),
    })
  }
}
