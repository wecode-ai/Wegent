import assert from 'node:assert/strict'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
import { reloadMainWindow } from './workspace-flows.mjs'

const MARKER = 'TEXT_ATTACHMENT_PREVIEW_REGRESSION'
const DRAFT = 'Keep this unsent draft while viewing the attachment.'
const PANEL = '[data-testid="composer-attachment-preview-panel"]'
const PREVIEW = `${PANEL} [data-testid="workspace-file-preview"]`
const OPEN = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="attachment-text-open-button"]`
const SENT = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-text-attachment"]`
const RETRY = `${PANEL} [data-testid="workspace-file-preview-retry-button"]`
const CONTENT = `${MARKER}\n${'完整文本 attachment preview '.repeat(7000).trim()}\nEND_OF_FULL_ATTACHMENT`

async function assertFullPreview(control) {
  await control.command('waitFor', PREVIEW, { visible: true })
  // Three long lines keep every byte measurable in the rendered code view.
  await control.command('waitFor', '[data-code] [data-line]', { text: MARKER, visible: true })
  const rendered = await control.command('getText', '[data-code] [data-line]', { visible: true })
  assert.ok(rendered === CONTENT, 'The text preview did not render the complete original file')
  assert.equal(
    Number(await control.command('getElementCount', `${PANEL} [contenteditable="true"]`)),
    0,
    'Attachment preview must remain read-only'
  )
}

export function createTextAttachmentPreview({ workspacePath, captureScreenshot }) {
  let active = false
  let requests = 0
  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(
        JSON.stringify(body.input).includes(MARKER),
        'The native request lost its attachment context'
      )
      requests++
      const events = streamingTextEvents(MARKER, `${MARKER}_COMPLETE`, 'final_answer')
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([...events.start, ...events.finish]))
      return true
    },

    async verify(control) {
      active = true
      const path = join(workspacePath, 'large-text-attachment.txt')
      const movedPath = `${path}.moved`
      const preferenceKey = 'wework.workspace-opener-preferences'
      const previous = await control.command('getLocalStorageItem', 'body', {
        value: preferenceKey,
      })
      try {
        await writeFile(path, CONTENT)
        const opener = process.platform === 'win32' ? 'powershell' : 'terminal'
        await control.command('setLocalStorageItem', 'body', {
          value: JSON.stringify({
            key: preferenceKey,
            value: JSON.stringify({ global: opener, perPath: { [workspacePath]: opener } }),
          }),
        })
        await selectE2EModel(control)
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: DRAFT })
        await control.command('pasteText', ACTIVE_COMPOSER_SELECTOR, { value: CONTENT })
        await control.command('waitFor', OPEN)
        await control.command('click', OPEN)
        await assertFullPreview(control)
        assert.equal(await control.command('getValue', ACTIVE_COMPOSER_SELECTOR), DRAFT)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="attachment-badge"]`
        )

        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: MARKER })
        await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: `${MARKER}_COMPLETE` }
        )
        assert.equal(requests, 1, 'Previewing unexpectedly submitted an extra model request')
        await control.command('click', SENT)
        await assertFullPreview(control)
        await captureScreenshot(control, 'text-attachment-preview-sent.png', 'body')
        await reloadMainWindow(control, 'Attachment preview reload did not reconnect')
        await control.command('waitFor', SENT)
        await control.command('click', SENT)
        await assertFullPreview(control)
        await captureScreenshot(control, 'text-attachment-preview-restored.png', 'body')

        // A real missing local file exercises the viewer's error and retry path.
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: DRAFT })
        await control.command('pastePaths', ACTIVE_COMPOSER_SELECTOR, {
          value: JSON.stringify([
            {
              uri: pathToFileURL(path).href,
              name: 'large-text-attachment.txt',
              isDirectory: false,
            },
          ]),
        })
        await control.command('waitFor', '[data-testid="attachment-document-preview-button"]')
        await rename(path, movedPath)
        await control.command('click', '[data-testid="attachment-document-preview-button"]')
        await control.command('waitFor', RETRY)
        await rename(movedPath, path)
        await control.command('click', RETRY)
        await assertFullPreview(control)
        assert.equal(await readFile(path, 'utf8'), CONTENT)
        assert.equal(await control.command('getValue', ACTIVE_COMPOSER_SELECTOR), DRAFT)
        assert.equal(requests, 1, 'Retrying the preview unexpectedly submitted the draft')
      } finally {
        active = false
        if (!previous)
          await control.command('removeLocalStorageItem', 'body', { value: preferenceKey })
        else
          await control.command('setLocalStorageItem', 'body', {
            value: JSON.stringify({ key: preferenceKey, value: previous }),
          })
        await rm(path, { force: true })
        await rm(movedPath, { force: true })
      }
    },
  }
}
