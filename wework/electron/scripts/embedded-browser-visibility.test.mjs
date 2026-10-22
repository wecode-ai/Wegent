import assert from 'node:assert/strict'
import { test } from 'vitest'
import { waitForEmbeddedBrowserVisibility } from '../../e2e/desktop/modules/embedded-browser-visibility.mjs'

const previewSelector = '[data-testid="workspace-tab-content-owner"]'
const state = { visible: false, url: 'http://127.0.0.1:12345/', isLoading: false }

test('reports an inactive preview startup error instead of a misleading visibility timeout', async () => {
  const control = {
    async command(action, selector) {
      if (action === 'getElementCount') {
        assert.equal(
          selector,
          `${previewSelector} [data-testid="smart-app-development-preview-error"]`
        )
        return '1'
      }
      if (action === 'getText') return 'Timed out waiting for process group 2398 to exit'
      throw new Error('Embedded browser is unavailable: app')
    },
  }

  await assert.rejects(
    waitForEmbeddedBrowserVisibility(control, 'app', false, 150, 'not hidden', previewSelector),
    /Smart app development preview failed: Timed out waiting for process group 2398 to exit/
  )
})

test('retains the last browser query error when the preview never returns', async () => {
  const control = {
    async command(action) {
      if (action === 'getElementCount') return '0'
      throw new Error('Embedded browser is unavailable: app')
    },
  }

  await assert.rejects(
    waitForEmbeddedBrowserVisibility(control, 'app', false, 150, 'not hidden', previewSelector),
    /not hidden:.*Embedded browser is unavailable: app/
  )
})

test('requires a real hidden replacement after temporary browser removal', async () => {
  let queries = 0
  const control = {
    async command(action) {
      if (action === 'getElementCount') return '0'
      queries += 1
      if (queries === 1) throw new Error('Embedded browser is unavailable: app')
      return JSON.stringify(state)
    },
  }

  assert.deepEqual(
    await waitForEmbeddedBrowserVisibility(
      control,
      'app',
      false,
      1000,
      'not hidden',
      previewSelector
    ),
    state
  )
  assert.equal(queries, 2)
})

test('does not accept a visible browser when the inactive preview must stay hidden', async () => {
  const control = {
    async command(action) {
      if (action === 'getElementCount') return '0'
      return JSON.stringify({ ...state, visible: true })
    },
  }

  await assert.rejects(
    waitForEmbeddedBrowserVisibility(control, 'app', false, 150, 'not hidden', previewSelector),
    /not hidden:.*"visible":true/
  )
})

test('requires the restored visible browser to finish loading', async () => {
  const control = {
    async command(action) {
      if (action === 'getElementCount') return '0'
      return JSON.stringify({ ...state, visible: true, isLoading: true })
    },
  }

  await assert.rejects(
    waitForEmbeddedBrowserVisibility(control, 'app', true, 150, 'not ready', previewSelector),
    /not ready:.*"isLoading":true/
  )
})
