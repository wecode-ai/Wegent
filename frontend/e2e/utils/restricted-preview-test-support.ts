// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  expect,
  type Download,
  type Locator,
  type Page,
  type Response,
  type TestInfo,
} from '@playwright/test'

const FORBIDDEN_ACTIONS = /download|export|print|下载|导出|打印/i

async function expectRestrictedControls(dialog: Locator): Promise<void> {
  await expect(dialog.getByTestId('flyfish-office-file-viewer')).toBeVisible()
  await expect(dialog.getByRole('button', { name: FORBIDDEN_ACTIONS })).toHaveCount(0)
  await expect(dialog.getByRole('link', { name: FORBIDDEN_ACTIONS })).toHaveCount(0)
  await expect(dialog.locator('a[download], a[target="_blank"]')).toHaveCount(0)
  await expect(dialog.getByTestId('document-link-preview-error')).toHaveCount(0)
}

function previewTrigger(page: Page, filename: string): Locator {
  return page
    .getByTestId('document-link-preview-card')
    .filter({ hasText: filename })
    .getByTestId('document-link-preview-trigger')
}

function previewCard(page: Page, filename: string): Locator {
  return page.getByTestId('document-link-preview-card').filter({ hasText: filename })
}

export async function expectSingleRenderedWatermark(
  scope: Locator,
  watermarkText: string
): Promise<void> {
  const watermark = scope.getByTestId('knowledge-document-watermark')
  await expect(watermark).toHaveCount(1)
  await expect(watermark).toHaveAttribute('data-watermark-text', watermarkText)
  await expect(watermark).toHaveCSS('background-image', /data:image\/png;base64,/)
}

async function expectPdfRange(page: Page, response: Response): Promise<void> {
  expect(response.status()).toBe(206)
  const requestRange = response
    .request()
    .headers()
    .range.match(/^bytes=(\d+)-(\d+)$/)!
  const contentRange = response.headers()['content-range']?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
  expect(contentRange, 'PDF.js must receive a valid range from the file origin').toBeTruthy()
  const [, start, end, total] = contentRange!
  expect(Number(start)).toBeGreaterThan(0)
  expect(Number(start)).toBe(Number(requestRange[1]))
  expect(Number(end)).toBe(Math.min(Number(requestRange[2]), Number(total) - 1))
  expect(response.headers()['content-type']).toBe('application/pdf')
  expect(response.headers()['accept-ranges']).toBe('bytes')
  expect(response.headers()['access-control-allow-origin']).toBe('*')
  expect(response.headers()['access-control-expose-headers']).toContain('Content-Range')

  // CI traces show PDF.js rendering successfully while its range requests end
  // with ERR_ABORTED. Neither requestfinished nor CDP response.body() is a
  // reliable way to inspect those bytes. Read the observed range from the real
  // origin in the page, so CORS and the actual response body are still checked.
  const received = await page.evaluate(
    async ({ url, range }) => {
      const result = await fetch(url, {
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        headers: { Range: range },
        signal: AbortSignal.timeout(15_000),
      })
      return {
        status: result.status,
        contentRange: result.headers.get('content-range'),
        contentLength: result.headers.get('content-length'),
        contentType: result.headers.get('content-type'),
        byteLength: (await result.arrayBuffer()).byteLength,
      }
    },
    { url: response.url(), range: response.request().headers().range }
  )
  expect(received).toEqual({
    status: 206,
    contentRange: response.headers()['content-range'],
    contentLength: String(Number(end) - Number(start) + 1),
    contentType: 'application/pdf',
    byteLength: Number(end) - Number(start) + 1,
  })
}

async function verifyPdfPreview(page: Page, dialog: Locator, origin: string): Promise<void> {
  const [range] = await Promise.all([
    page.waitForResponse(
      response =>
        response.url() === `${origin}/preview.pdf` &&
        /^bytes=[1-9]\d*-\d+$/.test(response.request().headers().range || '')
    ),
    previewTrigger(page, 'preview.pdf').click(),
  ])
  // A nonzero range cannot be the application's bytes=0-15 signature probe.
  await expectPdfRange(page, range)
  const firstPage = dialog.locator('.pdfViewer .page[data-page-number="1"]')
  await expect(firstPage.locator('canvas')).toBeVisible({ timeout: 30_000 })
  await expect(
    firstPage.locator('.textLayer').getByText('DINGTALK PDF PAGE 1', { exact: true })
  ).toBeVisible()
  await expect(dialog.getByTestId('pdf-preview-loading')).toHaveCount(0)
  await expectRestrictedControls(dialog)
  // The real renderer exposes navigation on wide layouts and a toggle on compact ones.
  const navigation = dialog.locator('.pdf-toolbar button[aria-pressed]')
  if ((await navigation.getAttribute('aria-pressed')) === 'false') await navigation.click()
  await dialog.locator('.pdf-page-button').last().click()
  const lastPage = dialog.locator('.pdfViewer .page[data-page-number="3"]')
  await expect(lastPage.locator('canvas')).toBeVisible()
  await expect(
    lastPage.locator('.textLayer').getByText('DINGTALK PDF PAGE 3', { exact: true })
  ).toBeVisible()
}

async function verifyVideoPreview(
  page: Page,
  dialog: Locator,
  origin: string,
  watermarkText: string
): Promise<void> {
  const [range] = await Promise.all([
    page.waitForResponse(
      response =>
        response.url() === `${origin}/preview.mp4` &&
        response.request().headers().range === 'bytes=0-0'
    ),
    previewTrigger(page, 'preview.mp4').click(),
  ])
  expect(range.status()).toBe(206)
  const video = dialog.locator('video')
  await expect(video).toBeVisible()
  // Visibility alone cannot detect a codec failure, so require the media
  // element to actually decode its metadata before checking the guards.
  const loaded = video.evaluate(element => {
    const media = element as HTMLVideoElement
    return new Promise<boolean>(resolve => {
      if (media.videoWidth > 0) {
        resolve(true)
        return
      }
      media.addEventListener('loadedmetadata', () => resolve(media.videoWidth > 0), {
        once: true,
      })
      media.addEventListener('error', () => resolve(false), { once: true })
    })
  })
  expect(await loaded, 'video media failed to load or decode').toBe(true)
  expect((await video.getAttribute('controlslist'))?.split(/\s+/)).toContain('nofullscreen')
  await expectSingleRenderedWatermark(dialog, watermarkText)
}

export async function verifyWatermarkFailureRecovery(
  page: Page,
  watermarkText: string
): Promise<void> {
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toDataURL
    let failNextWatermark = true
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      if (failNextWatermark) {
        failNextWatermark = false
        throw new Error('E2E_WATERMARK_GENERATION_FAILED')
      }
      return original.apply(this, args)
    }
  })

  await previewTrigger(page, 'preview.txt').click()
  const dialog = page.getByTestId('document-link-preview-dialog')
  await expect(dialog.getByTestId('knowledge-watermark-unavailable')).toBeVisible()
  await expect(dialog.getByText('DINGTALK TEXT PREVIEW CONTENT', { exact: true })).toHaveCount(0)
  await dialog.getByTestId('knowledge-watermark-retry').click()
  await expect(dialog.getByText('DINGTALK TEXT PREVIEW CONTENT', { exact: true })).toBeVisible()
  await expectSingleRenderedWatermark(dialog, watermarkText)
  await dialog.getByRole('button', { name: /close/i }).click()
}

async function verifyOfficePreview(page: Page, dialog: Locator, origin: string): Promise<void> {
  const [request] = await Promise.all([
    // Opening the dialog can abort an earlier load after its response headers.
    // Inspect the completed browser transfer that supplies the real renderer.
    page.waitForEvent(
      'requestfinished',
      request => request.method() === 'GET' && request.url() === `${origin}/preview.docx`
    ),
    previewTrigger(page, 'preview.docx').click(),
  ])
  const response = (await request.response())!
  expect(response.status()).toBe(200)
  expect(response.headers()['access-control-allow-origin']).toBe('*')
  expect((await response.body()).subarray(0, 2).toString()).toBe('PK')
  await expect(
    dialog.locator('.docx-wrapper').getByText('DINGTALK OFFICE PREVIEW CONTENT', { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expectRestrictedControls(dialog)
}

async function verifyUnavailableFile(page: Page, dialog: Locator, origin: string): Promise<void> {
  const [missing] = await Promise.all([
    page.waitForResponse(response => response.url() === `${origin}/unavailable.txt`),
    previewTrigger(page, 'unavailable.txt').click(),
  ])
  expect(missing.status()).toBe(404)
  const error = dialog.getByTestId('document-link-preview-error')
  await expect(error).toBeVisible()
  await expect(error).toContainText('The file does not exist or the link is no longer valid.')
  await expect(dialog.getByTestId('document-link-preview-retry')).toBeVisible()
}

export async function verifyRestrictedFilePreviews(
  page: Page,
  origin: string,
  testInfo: TestInfo,
  watermarkText: string
): Promise<void> {
  const originalUrl = page.url()
  expect(new URL(originalUrl).origin).not.toBe(origin)
  const openedPages: Page[] = []
  const downloads: string[] = []
  const responses: Array<Record<string, string | number>> = []
  const onPage = (opened: Page) => openedPages.push(opened)
  const onDownload = (download: Download) => downloads.push(download.suggestedFilename())
  const onResponse = (response: Response) => {
    if (!response.url().startsWith(`${origin}/`)) return
    responses.push({
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
      range: response.request().headers().range || '',
      contentRange: response.headers()['content-range'] || '',
      contentLength: response.headers()['content-length'] || '',
      allowOrigin: response.headers()['access-control-allow-origin'] || '',
    })
  }
  page.context().on('page', onPage)
  page.on('download', onDownload)
  page.on('response', onResponse)
  const dialog = page.getByTestId('document-link-preview-dialog')
  const network = await page.context().newCDPSession(page)
  try {
    // Throttle only the real PDF transfer so PDF.js requests its distant xref.
    // Renderer chunks and workers must load at normal speed.
    await network.send('Network.enable')
    await network.send('Network.setCacheDisabled', { cacheDisabled: true })
    await network.send('Network.emulateNetworkConditionsByRule', {
      offline: false,
      matchedNetworkConditions: [
        {
          urlPattern: `${origin}/preview.pdf`,
          latency: 20,
          downloadThroughput: 256 * 1024,
          uploadThroughput: -1,
        },
      ],
    })
    await verifyPdfPreview(page, dialog, origin)
    await expectSingleRenderedWatermark(dialog, watermarkText)
    expect(page.url()).toBe(originalUrl)
    await dialog.getByRole('button', { name: /close/i }).click()
    await verifyOfficePreview(page, dialog, origin)
    await expectSingleRenderedWatermark(dialog, watermarkText)
    expect(page.url()).toBe(originalUrl)
    await dialog.getByRole('button', { name: /close/i }).click()
    await verifyVideoPreview(page, dialog, origin, watermarkText)
    expect(page.url()).toBe(originalUrl)
    await dialog.getByRole('button', { name: /close/i }).click()
    await verifyUnavailableFile(page, dialog, origin)
    expect(page.url()).toBe(originalUrl)
    expect(openedPages).toEqual([])
    expect(downloads).toEqual([])
  } finally {
    page.context().off('page', onPage)
    page.off('download', onDownload)
    page.off('response', onResponse)
    await testInfo.attach('restricted-preview-http', {
      body: JSON.stringify(responses, null, 2),
      contentType: 'application/json',
    })
    await network.detach()
  }
}

export async function verifyAllowedPreviewCoverWatermarks(
  page: Page,
  watermarkText: string
): Promise<void> {
  for (const filename of ['preview.pdf', 'preview.docx', 'preview.mp4', 'preview.txt']) {
    await expectSingleRenderedWatermark(previewCard(page, filename), watermarkText)
  }
}

export async function verifyProtectedPreviewUsesOneWatermark(
  page: Page,
  watermarkText: string
): Promise<void> {
  const protectedContent = page.getByTestId('knowledge-protected-content')
  await expectSingleRenderedWatermark(protectedContent, watermarkText)
  for (const filename of ['preview.pdf', 'preview.docx', 'preview.mp4', 'preview.txt']) {
    await expect(
      previewCard(page, filename).getByTestId('knowledge-document-watermark')
    ).toHaveCount(0)
  }

  await previewTrigger(page, 'preview.txt').click()
  const dialog = page.getByTestId('document-link-preview-dialog')
  await expect(dialog.getByText('DINGTALK TEXT PREVIEW CONTENT', { exact: true })).toBeVisible()
  await expectSingleRenderedWatermark(dialog, watermarkText)
  await dialog.getByRole('button', { name: /close/i }).click()
}
