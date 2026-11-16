// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createBarrier as barrier } from '../test/async-barrier'
import { verifyHarnessLifecycle } from '../../e2e/desktop/modules/harness-app-lifecycle.mjs'

test('private Smart app scope is reopened only after its owner list refreshes', async () => {
  const waiting = barrier()
  const refreshed = barrier()
  const reachedReopenedScope = new Error('Reopened private scope is ready')
  let selectedScope = 'public'
  let privateSaved = false
  let privateCatalogRead = false
  let reopened = false
  const visibility =
    '[data-workspace-tab-content][aria-hidden="false"] [data-testid="smart-app-visibility-3"]'
  const verification = verifyHarnessLifecycle(
    {
      async command(action: string, selector: string) {
        if (action === 'getText') return '未选择文件；将使用已导入的发布包；关联文件夹'
        if (action === 'snapshot')
          return JSON.stringify({ location: '/sites?app_type=smart_app&view=owned' })
        if (action === 'getAttribute') return 'management'
        if (action === 'getElementCount') return 0
        if (
          selector === '[data-testid="smart-app-share-scope-private"]' &&
          action === 'clickWhenEnabled'
        )
          selectedScope = 'private'
        if (selector === '[data-testid="smart-app-share-save"]' && selectedScope === 'private')
          privateSaved = true
        if (selector === visibility && privateSaved) {
          if (action === 'click') throw new Error('Smart app owner list is still refreshing')
          assert.equal(action, 'clickWhenEnabled')
          assert.equal(privateCatalogRead, true)
          waiting.release()
          await refreshed.promise
          reopened = true
        }
        if (
          selector === '[data-testid="smart-app-share-scope-private"]' &&
          action === 'waitFor' &&
          reopened
        )
          throw reachedReopenedScope
      },
    },
    {
      packagePath: '/fixture/app.zip',
      importedPackagePath: '/fixture/imported.zip',
      resultDir: '/fixture/results',
      downloadsPath: '/fixture/downloads',
      uiTimeoutMs: 1000,
      sharedSmartAppId: 3,
      captureScreenshot: async () => {},
      async ownerRequest(path: string) {
        assert.equal(path, '/api/smart-apps/marketplace?source=public')
        privateCatalogRead = true
        return { items: [] }
      },
    }
  ).then(
    () => new Error('Expected the reopened-scope boundary'),
    (error: unknown) => error
  )
  assert.equal(await Promise.race([waiting.promise.then(() => 'waiting'), verification]), 'waiting')
  assert.equal(reopened, false)
  refreshed.release()
  assert.equal(await verification, reachedReopenedScope)
})
