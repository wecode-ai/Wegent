import assert from 'node:assert/strict'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  IMAGE_ARTIFACT_BASE64,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'

const INITIAL_PROMPT = 'WEWORK_DESKTOP_E2E_CLOUD_CONTEXT_STALL_INITIAL'
const INITIAL_COMPLETION = 'WEWORK_DESKTOP_E2E_CLOUD_CONTEXT_STALL_INITIAL_COMPLETE'
const FOLLOW_UP_PROMPT = 'WEWORK_DESKTOP_E2E_CLOUD_CONTEXT_STALL_FOLLOW_UP'
const FOLLOW_UP_COMPLETION = 'WEWORK_DESKTOP_E2E_CLOUD_CONTEXT_STALL_FOLLOW_UP_COMPLETE'
const ATTACHMENT_FILENAME = 'cloud-context-stall.png'

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function completedResponse(id, text) {
  return [
    { type: 'response.created', response: { id } },
    {
      type: 'response.output_item.done',
      item: {
        id: `${id}-message`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]
}

async function readRequestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function waitForCloudContextRequest(requestCount, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (requestCount() > 0) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The active runtime task did not request its cloud project-space context')
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  let cloudContextRequests = 0
  let modelRequestSequence = 0
  let releaseInitialResponse = () => {}
  const initialResponseRelease = new Promise(resolve => {
    releaseInitialResponse = resolve
  })

  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/v1/cloud-projects') {
        json(response, 200, { items: [] })
        return true
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/runtime-tasks/cloud-context') {
        cloudContextRequests += 1
        return true
      }

      if (request.method === 'POST' && ['/responses', '/v1/responses'].includes(url.pathname)) {
        const body = await readRequestBody(request)
        const completion = body.includes(FOLLOW_UP_PROMPT)
          ? FOLLOW_UP_COMPLETION
          : body.includes(INITIAL_PROMPT)
            ? INITIAL_COMPLETION
            : null
        if (!completion) return false
        modelRequestSequence += 1
        const responseId = `wework-cloud-context-stall-${modelRequestSequence}`
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        const events = completedResponse(responseId, completion)
        if (completion === INITIAL_COMPLETION) {
          response.flushHeaders()
          response.write(sse(events.slice(0, 1)))
          await initialResponseRelease
          response.end(sse(events.slice(1)))
        } else {
          response.end(sse(events))
        }
        return true
      }

      return false
    },

    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'cloud-context-resilience')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: INITIAL_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await waitForCloudContextRequest(() => cloudContextRequests, uiTimeoutMs)

      await control.command('waitFor', '[data-testid="project-space-context-pill"]', {
        timeoutMs: uiTimeoutMs,
      })
      const stalledContextSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.equal(
        stalledContextSnapshot.testIds.includes('work-item-guide-summary-pending'),
        false,
        'A stalled cloud context lookup left the composer guide permanently binding'
      )

      await control.command('pasteFile', ACTIVE_COMPOSER_SELECTOR, {
        filename: ATTACHMENT_FILENAME,
        mimeType: 'image/png',
        value: IMAGE_ARTIFACT_BASE64,
      })
      await control.command('waitFor', '[data-testid="attachment-badge"]', {
        timeoutMs: uiTimeoutMs,
      })
      const attachmentSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.equal(
        attachmentSnapshot.testIds.includes('uploading-attachment-badge'),
        false,
        'An attachment remained uploading while the cloud context request was stalled'
      )
      assert.equal(
        attachmentSnapshot.testIds.includes('attachment-error-badge'),
        false,
        'An attachment failed while the cloud context request was stalled'
      )

      releaseInitialResponse()
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: INITIAL_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: FOLLOW_UP_PROMPT })
      await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FOLLOW_UP_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      assert.ok(
        cloudContextRequests > 0,
        'The scenario did not keep a cloud context request pending'
      )
      await captureScreenshot(control, 'cloud-context-resilience.png', ACTIVE_WORKBENCH_SELECTOR)
    },

    diagnostics() {
      return { cloudContextRequests, modelRequestSequence }
    },

    cleanup() {
      releaseInitialResponse()
    },
  }
}
