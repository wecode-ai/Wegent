import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APP_BASE_PATH,
  injectRuntimeConfig,
  resolveBackendUrl,
} from './index.js'

test('normalizes backend URLs without copying an API suffix', () => {
  assert.equal(
    resolveBackendUrl({
      WEGENT_BACKEND_URL: 'https://cloud.example.com/root/api/v1',
    }),
    'https://cloud.example.com/root'
  )
  assert.equal(resolveBackendUrl({}), null)
})

test('injects the same-origin DSH application runtime configuration', () => {
  const html = injectRuntimeConfig(
    '<html><head></head><body></body></html>',
    {
      WEWORK_BACKEND_URL: 'http://127.0.0.1:8000',
      WEWORK_E2E_CONTROL_TOKEN: 'control-token',
      WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:43111',
      WEWORK_E2E_LOCAL_MODELS_CATALOG_READY: 'false',
      WEWORK_E2E_POSTHOG_KEY: 'posthog-test-key',
      WEWORK_E2E_SEED_LOCAL_MODELS: 'true',
      WEWORK_E2E_TRANSCRIPT_PAGE_SIZE: '20',
      WEWORK_E2E_WORKTREE_CREATION_DELAY_MS: '1500',
    }
  )

  assert.match(html, /window\.__WEWORK_RUNTIME_CONFIG__/)
  assert.match(html, new RegExp(`"appBasePath":"${APP_BASE_PATH}"`))
  assert.ok(html.includes('"desktopHost":"electron"'))
  assert.ok(html.includes('"apiBaseUrl":"/wework/api"'))
  assert.ok(html.includes('"socketPath":"/wework/socket.io"'))
  assert.ok(html.includes('"controlToken":"control-token"'))
  assert.ok(html.includes('"controlUrl":"http://127.0.0.1:43111"'))
  assert.ok(html.includes('"posthogKey":"posthog-test-key"'))
  assert.ok(html.includes('"localModelsCatalogReady":false'))
  assert.ok(html.includes('"seedLocalModels":true'))
  assert.ok(html.includes('"transcriptPageSize":20'))
  assert.ok(html.includes('"worktreeCreationDelayMs":1500'))
})

test('injects the Electron workspace window label', () => {
  const html = injectRuntimeConfig(
    '<html><head></head><body></body></html>',
    {},
    'workspace-task-1-123'
  )

  assert.ok(html.includes('"desktopWindowLabel":"workspace-task-1-123"'))
})

test('injects Electron auxiliary window labels', () => {
  for (const label of ['popout-window', 'system-drag-panel']) {
    const html = injectRuntimeConfig(
      '<html><head></head><body></body></html>',
      {},
      label
    )

    assert.ok(html.includes(`"desktopWindowLabel":"${label}"`))
  }
})
