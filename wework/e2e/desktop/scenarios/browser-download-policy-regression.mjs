import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertNoNativeSaveDialog,
  triggerEmbeddedBrowserContextMenuItem,
  withNativeSaveDialog,
} from '../modules/native-download-dialogs.mjs'

const DOWNLOAD_FIXTURE_PATH = '/embedded-browser-download-fixture'
const DOWNLOAD_FILE_PATH = '/embedded-browser-download-file'
const DOWNLOAD_SAVE_AS_REDIRECT_PATH = '/embedded-browser-download-save-as-redirect'
const DOWNLOAD_IMAGE_PATH = '/embedded-browser-download-image.png'
const DOWNLOAD_FIXTURE_TITLE = 'Embedded Browser Download Policy Fixture'

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
  if (url.pathname === DOWNLOAD_FIXTURE_PATH) {
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

export async function verifyBrowserDownloadPolicy({
  bridgeCall,
  control,
  downloadsPath,
  resultDir,
  uiTimeoutMs,
}) {
  await mkdir(downloadsPath, { recursive: true })
  const fixtureUrl = `${control.url}${DOWNLOAD_FIXTURE_PATH}`
  const chosenDir = join(resultDir, 'user-chosen-downloads')
  const customDownloadsDir = join(resultDir, 'custom-downloads')
  const blockingFile = join(resultDir, 'unwritable-download-parent')
  const unwritableCustomDir = join(blockingFile, 'nested-downloads')
  await mkdir(chosenDir, { recursive: true })

  const pid = control.applicationProcessId

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
    await assertNoNativeSaveDialog(pid)

    // 4. Real link right-click menu ("Save Link As...") with HTTP 302 redirect:
    //    cancel once, save to user-chosen location, then verify subsequent direct save recovers.
    await withNativeSaveDialog(
      control,
      () =>
        triggerEmbeddedBrowserContextMenuItem({
          bridgeCall,
          control,
          downCount: LINK_SAVE_AS_MENU_DOWN_COUNT,
          resultDir,
          stepName: 'link-save-as-cancel',
          targetSelector: '#save-as-link',
          timeoutMs: uiTimeoutMs,
        }),
      { action: 'cancel', resultDir, stepName: 'link-save-as-cancel', timeoutMs: uiTimeoutMs }
    )
    assert.equal(existsSync(join(downloadsPath, 'saved-link.mp4')), false)

    const chosenLinkPath = join(chosenDir, 'chosen-link.mp4')
    await withNativeSaveDialog(
      control,
      () =>
        triggerEmbeddedBrowserContextMenuItem({
          bridgeCall,
          control,
          downCount: LINK_SAVE_AS_MENU_DOWN_COUNT,
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
    await withNativeSaveDialog(
      control,
      () =>
        triggerEmbeddedBrowserContextMenuItem({
          bridgeCall,
          control,
          downCount: IMAGE_SAVE_AS_MENU_DOWN_COUNT,
          resultDir,
          stepName: 'image-save-as-cancel',
          targetSelector: '#save-as-image',
          timeoutMs: uiTimeoutMs,
        }),
      { action: 'cancel', resultDir, stepName: 'image-save-as-cancel', timeoutMs: uiTimeoutMs }
    )
    assert.equal(existsSync(join(downloadsPath, 'embedded-browser-download-image.png')), false)

    const chosenImagePath = join(chosenDir, 'chosen-image.png')
    await withNativeSaveDialog(
      control,
      () =>
        triggerEmbeddedBrowserContextMenuItem({
          bridgeCall,
          control,
          downCount: IMAGE_SAVE_AS_MENU_DOWN_COUNT,
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
