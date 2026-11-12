import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  selectE2EModel,
} from './shared.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from './response-protocol.mjs'

export async function assertMarkdownPreviewAndSource(control, text, options = {}) {
  await control.command('waitFor', '[data-testid="workspace-markdown-preview"]', {
    ...options,
    text,
  })
  await control.command('clickWhenEnabled', '[data-testid="workspace-file-markdown-mode-button"]')
  await control.command('waitFor', '[data-testid="workspace-file-editor-content"]', {
    ...options,
    text,
  })
}

const CLOUD_HTML_LINK_MARKER = 'CLOUD_HTML_FILE_LINK_PREVIEW'
const CLOUD_HTML_RENDERED_MARKER = 'CLOUD_HTML_PREVIEW_RENDERED'
const CLOUD_HTML_SOURCE_MARKER = 'CLOUD_HTML_PREVIEW_SOURCE'

export function createCloudHtmlFileLinkPreview({ workspacePath, uiTimeoutMs }) {
  let active = false
  let markdown = ''

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const events = streamingTextEvents(CLOUD_HTML_LINK_MARKER, markdown, 'final_answer')
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([...events.start, ...events.finish]))
      return true
    },

    async verify(control) {
      const directory = join(workspacePath, 'cloud-html-preview')
      await mkdir(directory, { recursive: true })
      const filePath = join(directory, 'agreement.html').replaceAll('\\', '/')
      const html = [
        '<!doctype html>',
        '<html lang="zh-CN"><body>',
        `<h1 data-testid="cloud-html-rendered">${CLOUD_HTML_RENDERED_MARKER}</h1>`,
        `<!-- ${CLOUD_HTML_SOURCE_MARKER} -->`,
        '</body></html>',
      ].join('\n')
      await writeFile(filePath, html)
      markdown = `[agreement.html](<${filePath}>)`
      active = true
      try {
        await selectE2EModel(control)
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
          value: CLOUD_HTML_LINK_MARKER,
        })
        await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR)
        const links = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-testid="assistant-markdown-link"]`
        await control.command('waitFor', links, {
          text: 'agreement.html',
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`,
          { visible: false }
        )
        await control.command('clickElementWithText', links, { text: 'agreement.html' })
        const preview = '[data-testid="workspace-html-file-preview"]'
        await control.command('waitFor', preview, { timeoutMs: uiTimeoutMs })
        assert.equal(
          await control.command('getText', '[data-testid="workspace-file-path"]'),
          filePath,
          'The HTML link did not open its workspace file in the Files panel'
        )
        const frame = `${preview} iframe`
        assert.match(
          await control.command('getAttribute', frame, { value: 'srcdoc' }),
          new RegExp(CLOUD_HTML_RENDERED_MARKER),
          'The HTML file did not render its document content'
        )
        assert.equal(
          Number(
            await control.command('getElementCount', '[data-testid="workspace-browser-panel"]', {
              visible: true,
            })
          ),
          0,
          'The HTML link opened the embedded browser instead of the Files panel'
        )

        const modeButton = '[data-testid="workspace-file-markdown-mode-button"]'
        await control.command('clickWhenEnabled', modeButton)
        await control.command('waitFor', '[data-testid="workspace-file-editor-content"]', {
          text: CLOUD_HTML_SOURCE_MARKER,
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          Number(await control.command('getElementCount', preview, { visible: true })),
          0,
          'Switching to source left the rendered HTML preview mounted'
        )

        await control.command('clickWhenEnabled', modeButton)
        await control.command('waitFor', preview, { visible: true, timeoutMs: uiTimeoutMs })
        assert.match(
          await control.command('getAttribute', frame, { value: 'srcdoc' }),
          new RegExp(CLOUD_HTML_RENDERED_MARKER),
          'Switching back from source did not restore the rendered HTML'
        )
      } finally {
        active = false
      }
    },
  }
}
