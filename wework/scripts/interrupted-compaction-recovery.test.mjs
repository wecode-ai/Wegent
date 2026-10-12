import assert from 'node:assert/strict'
import test from 'node:test'

import * as scenario from '../e2e/desktop/scenarios/interrupted-context-compaction.mjs'

test('recovery waits for its own rendered indicator instead of counting historical DOM', async () => {
  const message = '[data-message-id="recovered-turn"]'
  let expanded = false
  let rendered = false
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'getAttribute') {
        assert.equal(options.text, 'WEWORK_E2E_INTERRUPTED_COMPACTION_RECOVERED')
        return 'recovered-turn'
      }
      assert.ok(selector.startsWith(message), 'Must scope recovery checks to its message')
      if (action === 'click') return ''
      if (action === 'waitFor' && selector.includes('aria-expanded="true"')) {
        expanded = true
        return ''
      }
      if (action === 'waitFor') {
        assert.equal(expanded, true)
        assert.equal(options.text, '上下文已自动压缩')
        rendered = true
        return options.text
      }
      if (action === 'getText') {
        assert.equal(rendered, true, 'Click does not synchronously render processing details')
        return '上下文已自动压缩'
      }
      throw new Error(`Unexpected command: ${action}`)
    },
  }
  await scenario.verifyRecoveredCompaction(control, 1000)
})
