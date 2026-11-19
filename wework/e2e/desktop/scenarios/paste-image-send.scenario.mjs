import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readRawRequestBody } from '../modules/response-protocol.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  IMAGE_ARTIFACT_BASE64,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'

const TIFF = JSON.parse(
  await readFile(new URL('../fixtures/clipboard-history-image.json', import.meta.url), 'utf8')
)

export function createDesktopScenario({ workspacePath, uiTimeoutMs }) {
  const received = new Set()
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRawRequestBody(request)
      const parsed = JSON.parse(body)
      const input = Array.isArray(parsed.input) ? parsed.input : []
      const turn = input.findLast(item => item.role === 'user')
      const marker = JSON.stringify(turn?.content ?? []).match(/PASTE_AND_SEND_(?:png|tiff)/)?.[0]
      if (!marker) return false
      const images = (turn.content ?? []).filter(item => item.type === 'input_image')
      assert.ok(images.length > 0, `${marker} reached the model without its pasted image`)
      received.add(marker)
      const id = `paste-send-${received.size}`
      const events = [
        { type: 'response.created', response: { id } },
        {
          type: 'response.output_item.done',
          item: {
            id: `${id}-message`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `${marker}_DONE`, annotations: [] }],
          },
        },
        {
          type: 'response.completed',
          response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      )
      return true
    },
    async verify(control) {
      await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command(
        'waitFor',
        '[data-testid="workspace-tab-select-fixed-task"][aria-selected="true"]'
      )
      await createSingleRootLocalProject(control, workspacePath, 'paste-image-send')
      await selectE2EModel(control)
      for (const type of process.platform === 'darwin' ? ['png', 'tiff'] : ['png']) {
        const marker = `PASTE_AND_SEND_${type}`
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: marker })
        await control.command('waitFor', '[data-testid="send-message-button"]', { enabled: true })
        await control.command('pasteFile', ACTIVE_COMPOSER_SELECTOR, {
          filename: `immediate.${type}`,
          mimeType: `image/${type}`,
          value: type === 'png' ? IMAGE_ARTIFACT_BASE64 : TIFF.base64,
        })
        // Submit immediately, without waiting for preview, conversion or upload.
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: `${marker}_DONE`,
          timeoutMs: uiTimeoutMs,
        })
        assert.ok(received.has(marker))
      }
    },
  }
}
