// @vitest-environment node

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal()),
  mkdir: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal()),
  runChecked: vi.fn().mockResolvedValue(undefined),
}))

import { completeLocalCollaborationFolderImport } from '../e2e/desktop/modules/workspace-flows.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from '../e2e/desktop/modules/shared.mjs'

function importControl(onImportCompletion) {
  const calls = []
  let path = '/tmp/native-home'
  return {
    calls,
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'fill' && selector.includes('device-folder-path-input')) path = options.value
      if (action === 'getValue') return path
      if (action === 'getText') return 'Ready'
      if (action === 'waitFor' && options.visible === false) return onImportCompletion()
    },
  }
}

test('folder import remains pending until the real importer closes after creation', async () => {
  let closeImporter
  const completed = new Promise(resolve => {
    closeImporter = resolve
  })
  const control = importControl(() => completed)
  let settled = false
  const importing = completeLocalCollaborationFolderImport(control, 'Clipboard images').then(() => {
    settled = true
  })

  await vi.waitFor(() => assert.equal(control.calls.at(-1)?.options?.visible, false))
  assert.equal(settled, false)
  assert.deepEqual(control.calls.slice(-2), [
    {
      action: 'clickWhenEnabled',
      selector: '[data-testid="confirm-local-project-create-button"]',
      options: { timeoutMs: DEFAULT_STEP_TIMEOUT_MS },
    },
    {
      action: 'waitFor',
      selector: '[data-testid="local-project-create-dialog"]',
      options: { visible: false, timeoutMs: DEFAULT_STEP_TIMEOUT_MS },
    },
  ])
  closeImporter()
  await importing
  assert.equal(settled, true)
})

test('failed import completion remains a checkpoint failure', async () => {
  const failure = new Error('The native project import did not complete')
  const control = importControl(() => Promise.reject(failure))
  await assert.rejects(
    completeLocalCollaborationFolderImport(control, 'Clipboard images'),
    error => error === failure
  )
  assert.equal(control.calls.at(-1).options.timeoutMs, DEFAULT_STEP_TIMEOUT_MS)
})
