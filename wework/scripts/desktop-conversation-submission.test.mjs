import assert from 'node:assert/strict'
import { test } from 'vitest'

import { sendPromptWithButton } from '../e2e/desktop/modules/conversation-navigation.mjs'

test('submits once after a restored conversation finishes loading its model catalog', async () => {
  const prompt = 'Continue the persisted conversation after restart'
  let catalogReady = false
  let composerValue = ''
  let submissions = 0
  let keyPresses = 0
  const catalogLoaded = new Promise(resolve => {
    setTimeout(() => {
      catalogReady = true
      resolve()
    }, 50)
  })
  const control = {
    async command(action, selector, options = {}) {
      switch (action) {
        case 'getElementCount':
          return '0'
        case 'fill':
          composerValue = options.value
          return ''
        case 'waitFor':
          if (options.enabled) {
            assert.ok(selector.includes('send-message-button'))
            await catalogLoaded
          } else {
            assert.equal(composerValue, options.text)
          }
          return ''
        case 'press':
          keyPresses += 1
          if (catalogReady) {
            submissions += 1
            composerValue = ''
          }
          return ''
        case 'snapshot':
          return JSON.stringify({ testIds: [], text: submissions ? prompt : '' })
        case 'getValue':
          return composerValue
        default:
          throw new Error(`Unexpected control action ${action}`)
      }
    },
  }

  await sendPromptWithButton(control, '[data-testid="chat-input"]', prompt, 500)

  assert.equal(submissions, 1)
  assert.equal(keyPresses, 1)
  assert.equal(composerValue, '')
})
