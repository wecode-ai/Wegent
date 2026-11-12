// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { expect, test } from '@playwright/test'

import { createPaginationDocx, DOCX_END, DOCX_START } from '../../utils/docx-pagination-fixture.mjs'

const frontendRequire = createRequire(__filename)
const presetRequire = createRequire(frontendRequire.resolve('@file-viewer/preset-office'))
const wordRequire = createRequire(presetRequire.resolve('@file-viewer/renderer-word'))
const viewerVersion = frontendRequire('@file-viewer/react/package.json').version
const engineVersion = wordRequire('@file-viewer/docx/package.json').version
const assetBase = `/file-viewer/${viewerVersion}-office-pdf-v3/vendor/docx`

// This renderer/asset boundary needs only the real static frontend, not accounts.
test.use({ storageState: { cookies: [], origins: [] } })

interface BrowserDocx {
  renderAsync(
    data: Uint8Array,
    body: HTMLElement,
    style: HTMLElement | null,
    options: Record<string, unknown>
  ): Promise<unknown>
}

for (const useWorker of [false, true]) {
  test(`DOCX floating drawings preserve readable bounded pages (${useWorker ? 'Worker' : 'main thread'})`, async ({
    page,
  }) => {
    // A static same-origin document lets the real Worker load normally. No
    // requests, parser output, layout measurements or renderer code are mocked.
    await page.goto('/mcp-oauth-pending.html')
    await page.setContent('<main id="preview" style="height:600px;overflow:auto"></main>')
    await page.addScriptTag({ url: `${assetBase}/${engineVersion}/jszip.min.js` })
    await page.addScriptTag({ path: wordRequire.resolve('@file-viewer/docx/browser') })
    const originalFile = process.env.DOCX_REGRESSION_FILE
    const buffer = originalFile ? await readFile(originalFile) : await createPaginationDocx()
    const workerResponses: number[] = []
    const workerUrls: string[] = []
    page.on('worker', worker => workerUrls.push(new URL(worker.url()).pathname))
    page.on('response', response => {
      if (response.url().includes(`/docx/${engineVersion}/docx.worker.js`)) {
        workerResponses.push(response.status())
      }
    })

    await page.evaluate(
      async ({ base64, useWorker, assetBase, engineVersion }) => {
        const library = (window as typeof window & { docx: BrowserDocx }).docx
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
        await library.renderAsync(bytes, document.getElementById('preview')!, null, {
          breakPages: true,
          useWorker,
          workerFallback: false,
          awaitLayout: true,
          workerUrl: new URL(`${assetBase}/${engineVersion}/docx.worker.js`, location.href).href,
          workerJsZipUrl: new URL(`${assetBase}/${engineVersion}/jszip.min.js`, location.href).href,
        })
      },
      { base64: buffer.toString('base64'), useWorker, assetBase, engineVersion }
    )

    const wrapper = page.locator('.docx-wrapper')
    await expect(wrapper).toHaveAttribute('data-docx-paginated', 'true')
    const pages = wrapper.locator('section.docx')
    expect(await pages.count()).toBeGreaterThan(1)
    expect(await pages.count()).toBeLessThan(30)
    if (originalFile) {
      // The original is an optional local input, never copied into the repo.
      expect((await pages.first().locator('article').innerText()).trim().length).toBeGreaterThan(5)
      expect((await wrapper.innerText()).length).toBeGreaterThan(100)
      await expect(pages.first().locator('article')).toBeInViewport()
      await page.screenshot({ path: test.info().outputPath('original-first-page.png') })
      await pages.last().scrollIntoViewIfNeeded()
      await expect(pages.last()).toBeInViewport()
      expect(await page.locator('#preview').evaluate(element => element.scrollTop)).toBeGreaterThan(
        0
      )
      await page.screenshot({ path: test.info().outputPath('original-last-page.png') })
    } else {
      const first = wrapper.getByText(DOCX_START, { exact: true })
      await expect(first).toBeInViewport()
      const last = wrapper.getByText(DOCX_END, { exact: true })
      await last.scrollIntoViewIfNeeded()
      await expect(last).toBeInViewport()
      expect(await page.locator('#preview').evaluate(element => element.scrollTop)).toBeGreaterThan(
        0
      )
    }
    if (useWorker) {
      expect(workerResponses).toEqual([200])
      expect(workerUrls).toContain(`${assetBase}/${engineVersion}/docx.worker.js`)
    } else {
      expect(workerUrls).toHaveLength(0)
    }
  })
}
