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

const MARKER = 'WINDOWS_MARKDOWN_FILE_LINKS'

export function createWindowsMarkdownFileLinks({ workspacePath, uiTimeoutMs }) {
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
      const events = streamingTextEvents(MARKER, markdown, 'final_answer')
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([...events.start, ...events.finish]))
      return true
    },

    async verify(control) {
      if (process.platform !== 'win32') return
      const directory = join(workspacePath, '研读与验证')
      await mkdir(directory, { recursive: true })
      const firstPath = join(directory, '整体 分层.sql').replaceAll('\\', '/')
      const secondPath = join(directory, '兴趣对象Top20.sql').replaceAll('\\', '/')
      await writeFile(firstPath, "SELECT 'WINDOWS_SQL_FIRST' AS marker;\n")
      await writeFile(secondPath, "SELECT 'WINDOWS_SQL_SECOND' AS marker;\n")
      const references = [
        ['slash-drive', `/${firstPath}`, firstPath, 'WINDOWS_SQL_FIRST'],
        ['encoded-drive', encodeURI(`/${secondPath}`), secondPath, 'WINDOWS_SQL_SECOND'],
        ['native-drive', secondPath, secondPath, 'WINDOWS_SQL_SECOND'],
        ['file-url', `file:///${firstPath}`, firstPath, 'WINDOWS_SQL_FIRST'],
      ]
      markdown = [
        MARKER,
        ...references.map(([label, href]) => `[${label}](<${href}>)`),
        `[missing-file](</${directory.replaceAll('\\', '/')}/missing.sql>)`,
      ].join('\n\n')
      active = true
      try {
        await selectE2EModel(control)
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: MARKER })
        await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR)
        const links = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-testid="assistant-markdown-link"]`
        await control.command('waitFor', links, { text: 'slash-drive', timeoutMs: uiTimeoutMs })
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`,
          { visible: false }
        )
        for (const [label, , expectedPath, content] of references) {
          await control.command('clickElementWithText', links, { text: label })
          await control.command('waitFor', '[data-testid="workspace-file-editor-content"]', {
            text: content,
            timeoutMs: uiTimeoutMs,
          })
          assert.equal(
            await control.command('getText', '[data-testid="workspace-file-path"]'),
            expectedPath,
            `The ${label} link did not open its absolute Windows path`
          )
        }
        await control.command('clickElementWithText', links, { text: 'missing-file' })
        await control.command('waitFor', '[data-testid="workspace-file-preview-retry-button"]')
        await control.command('waitFor', '[data-testid="right-workspace-panel"]', {
          text: 'Failed to resolve workspace file',
        })
        await control.command('clickElementWithText', links, { text: 'slash-drive' })
        await control.command('waitFor', '[data-testid="workspace-file-editor-content"]', {
          text: 'WINDOWS_SQL_FIRST',
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', '[data-testid="workspace-file-preview-retry-button"]', {
          visible: false,
        })
      } finally {
        active = false
      }
    },
  }
}
