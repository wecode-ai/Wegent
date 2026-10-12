import assert from 'node:assert/strict'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { selectE2EModel } from '../modules/shared.mjs'

const WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER = `${WORKBENCH} [data-testid="chat-message-input"][contenteditable="true"]`
const CANVAS = '[data-testid="drawing-canvas"] canvas.interactive'
const CONFIRM = '[data-testid="drawing-confirm-button"]'
const PROMPT = 'WEWORK_DRAWING_ATTACHMENT: explain this sketch.'
const COMPLETION = 'DRAWING_ATTACHMENT_RECEIVED'

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  let active = false
  let imageRequest = null

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(request)
      const isDrawing = JSON.stringify(body).includes(PROMPT)
      if (isDrawing) imageRequest = body
      const id = `drawing-attachment-${Date.now()}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          ...(isDrawing ? [assistantMessage(COMPLETION)] : []),
          responseCompleted(id),
        ])
      )
      return true
    },

    async verify(control) {
      active = true
      // Establish a fresh draft; no state from another checkpoint is required.
      await control.command('waitFor', '[data-testid="new-chat-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER, { timeoutMs: uiTimeoutMs })
      await selectE2EModel(control, undefined, undefined, WORKBENCH)

      // Canceling from @ preserves text and creates no attachment.
      await control.command('fill', COMPOSER, { value: `${PROMPT} @` })
      await control.command('waitFor', `${WORKBENCH} [data-testid="mention-draw-action"]`)
      await control.command('click', `${WORKBENCH} [data-testid="mention-draw-action"]`)
      await control.command('waitFor', CANVAS)
      assert.equal(await control.command('getAttribute', CONFIRM, { value: 'disabled' }), '')
      await control.command('click', '[data-testid="drawing-cancel-button"]')
      assert.equal(await control.command('getValue', COMPOSER), `${PROMPT} `)
      assert.equal(
        Number(
          await control.command('getElementCount', `${WORKBENCH} [data-testid="attachment-badge"]`)
        ),
        0
      )

      // The + entry uses the real canvas, export and local attachment storage.
      await control.command('click', `${WORKBENCH} [data-testid="add-context-button"]`)
      await control.command('click', '[data-testid="draw-attachment-button"]')
      await control.command('waitFor', CANVAS)
      await control.command('dragBy', CANVAS, { value: JSON.stringify({ x: 120, y: 80 }) })
      await control.command(
        'clickWhenEnabled',
        '[data-testid="drawing-canvas"] [data-testid="button-undo"]'
      )
      assert.equal(await control.command('getAttribute', CONFIRM, { value: 'disabled' }), '')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="drawing-canvas"] [data-testid="button-redo"]'
      )
      await captureScreenshot(
        control,
        'drawing-attachment-canvas.png',
        '[data-testid="drawing-attachment-dialog"]'
      )
      await control.command('clickWhenEnabled', CONFIRM)
      await control.command('waitFor', `${WORKBENCH} [data-testid="attachment-image-preview"]`)
      const filename = await control.command(
        'getAttribute',
        `${WORKBENCH} [data-testid="attachment-image-preview"]`,
        { value: 'alt' }
      )
      assert.match(filename, /^drawing-.+\.png$/)
      await control.command('click', `${WORKBENCH} [data-testid="remove-attachment-button"]`)
      assert.equal(
        Number(
          await control.command('getElementCount', `${WORKBENCH} [data-testid="attachment-badge"]`)
        ),
        0
      )

      // A new sketch reaches the actual agent request as a PNG image.
      await control.command('fill', COMPOSER, { value: `${PROMPT} @` })
      await control.command('click', `${WORKBENCH} [data-testid="mention-draw-action"]`)
      await control.command('waitFor', CANVAS)
      assert.equal(await control.command('getAttribute', CONFIRM, { value: 'disabled' }), '')
      await control.command('dragBy', CANVAS, { value: JSON.stringify({ x: 100, y: -60 }) })
      await control.command('clickWhenEnabled', CONFIRM)
      await control.command('waitFor', `${WORKBENCH} [data-testid="attachment-image-preview"]`)
      await captureScreenshot(control, 'drawing-attachment-composer.png', WORKBENCH)
      await control.command('clickWhenEnabled', `${WORKBENCH} [data-testid="send-message-button"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', { text: COMPLETION })
      assert.ok(imageRequest, 'The drawing never reached the model')
      assert.match(JSON.stringify(imageRequest), /input_image/)
      assert.match(JSON.stringify(imageRequest), /data:image\/png;base64,iVBOR/)
      assert.equal(
        Number(
          await control.command('getElementCount', `${WORKBENCH} [data-testid="attachment-badge"]`)
        ),
        0
      )
      await captureScreenshot(control, 'drawing-attachment-sent.png', WORKBENCH)
    },

    diagnostics() {
      return { drawingRequestReceived: imageRequest !== null }
    },
  }
}
