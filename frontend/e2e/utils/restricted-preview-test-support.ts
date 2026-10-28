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

async function expectPdfRange(response: Response): Promise<void> {
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
  expect((await response.body()).length).toBe(Number(end) - Number(start) + 1)
  expect(response.headers()['content-type']).toBe('application/pdf')
  expect(response.headers()['accept-ranges']).toBe('bytes')
  expect(response.headers()['access-control-allow-origin']).toBe('*')
  expect(response.headers()['access-control-expose-headers']).toContain('Content-Range')
}

async function verifyPdfPreview(page: Page, dialog: Locator, origin: string): Promise<void> {
  // A 206 response event only means headers arrived. PDF.js can cancel that
  // transfer, leaving no response body for Playwright to inspect.
  const [rangeRequest] = await Promise.all([
    page.waitForEvent(
      'requestfinished',
      request =>
        request.url() === `${origin}/preview.pdf` &&
        /^bytes=[1-9]\d*-\d+$/.test(request.headers().range || '')
    ),
    previewTrigger(page, 'preview.pdf').click(),
  ])
  // A nonzero range cannot be the application's bytes=0-15 signature probe.
  const range = await rangeRequest.response()
  expect(range, 'PDF.js must complete a real nonzero range request').not.toBeNull()
  await expectPdfRange(range!)
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

async function verifyOfficePreview(page: Page, dialog: Locator, origin: string): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === `${origin}/preview.docx`),
    previewTrigger(page, 'preview.docx').click(),
  ])
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
  testInfo: TestInfo
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
    // Throttle real transfers, without intercepting responses, so PDF.js requests
    // the distant xref before the full response finishes even on localhost.
    await network.send('Network.enable')
    await network.send('Network.setCacheDisabled', { cacheDisabled: true })
    await network.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 20,
      downloadThroughput: 256 * 1024,
      uploadThroughput: -1,
    })
    await verifyPdfPreview(page, dialog, origin)
    expect(page.url()).toBe(originalUrl)
    await dialog.getByRole('button', { name: /close/i }).click()
    await network.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await verifyOfficePreview(page, dialog, origin)
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
