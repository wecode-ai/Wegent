import assert from 'node:assert/strict'
import { onTestFinished, test } from 'vitest'
import { verifySideChatAttachmentIsolation } from '../e2e/desktop/modules/path-attachment-flows.mjs'
import {
  COMPLETION_TEXT,
  DEFAULT_STEP_TIMEOUT_MS,
  SIDE_CHAT_PROMPT,
} from '../e2e/desktop/modules/shared.mjs'

for (const readiness of ['immediate', 'delayed', 'timeout']) {
  test(`side chat submits once after send readiness: ${readiness}`, async () => {
    const previousMode = process.env.WEWORK_E2E_SCREENSHOTS
    process.env.WEWORK_E2E_SCREENSHOTS = 'final'
    onTestFinished(() => {
      if (previousMode === undefined) delete process.env.WEWORK_E2E_SCREENSHOTS
      else process.env.WEWORK_E2E_SCREENSHOTS = previousMode
    })
    let timer
    onTestFinished(() => clearTimeout(timer))
    const trace = []
    let ready = false
    let submissions = 0
    let readyPromise
    const control = {
      setScenario() {},
      async awaitScenarioRequestCount() {
        assert.equal(submissions, 1)
        throw new Error('Observed one side-chat request')
      },
      async command(action, selector, options = {}) {
        if (action === 'snapshot') {
          return JSON.stringify({
            text: COMPLETION_TEXT,
            testIds: selector.includes('right-workspace-chat-panel') ? ['attachment-badge'] : [],
          })
        }
        if (action === 'getElementCount') return '1'
        if (action === 'getElementMetrics') return JSON.stringify([{ width: 400 }])
        if (action === 'getConversationDiagnosticsSnapshot') return 'null'
        if (action === 'getValue') return SIDE_CHAT_PROMPT
        if (action === 'fill') {
          ready = readiness === 'immediate'
          trace.push(`draft filled; send enabled=${ready}`)
          if (readiness === 'delayed') {
            readyPromise = new Promise(resolve => {
              timer = setTimeout(() => {
                ready = true
                trace.push('send enabled after 900ms')
                resolve()
              }, 900)
            })
          }
        }
        if (selector.includes('send-message-button')) {
          trace.push(`${action}; enabled=${ready}`)
          if (action === 'clickWhenEnabled') {
            assert.equal(options.visible, true)
            assert.equal(options.timeoutMs, DEFAULT_STEP_TIMEOUT_MS)
            if (readiness === 'timeout') throw new Error('Timed out waiting for send readiness')
            await readyPromise
          }
          assert.ok(ready, `Clicked a disabled send button: ${trace.join(' -> ')}`)
          submissions += 1
        }
        return ''
      },
    }
    await assert.rejects(
      verifySideChatAttachmentIsolation({ control, taskRowTestId: 'source-task' }),
      readiness === 'timeout'
        ? /Timed out waiting for send readiness/
        : /Observed one side-chat request/,
      trace.join(' -> ')
    )
    assert.equal(submissions, readiness === 'timeout' ? 0 : 1)
    console.info(trace.join(' -> '))
  })
}
