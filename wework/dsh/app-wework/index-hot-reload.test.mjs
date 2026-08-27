import assert from 'node:assert/strict'
import test from 'node:test'
import { injectDevelopmentReload } from './index.js'

test('injects reload polling only into the original development application', () => {
  const html = '<html><head></head><body></body></html>'
  assert.equal(injectDevelopmentReload(html, {}, 'build-1'), html)

  const developmentHtml = injectDevelopmentReload(html, { WEWORK_APP_HOT_RELOAD: '1' }, 'build-1')
  assert.match(developmentHtml, /x-wework-app-build-id/)
  assert.match(developmentHtml, /"build-1"/)
  assert.match(developmentHtml, /window\.location\.reload/)
})
