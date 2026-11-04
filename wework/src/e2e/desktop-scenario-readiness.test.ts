import assert from 'node:assert/strict'
import { test } from 'vitest'

import { verifyHarnessLifecycle } from '../../e2e/desktop/modules/harness-app-lifecycle.mjs'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/stand-in-action-confirmation.scenario.mjs'
import { verifyCachedInitialRecovery } from '../../e2e/desktop/modules/issue-transcript-transfer.mjs'

test('cached Issue history settles its current read before injecting a new initial-read failure', async () => {
  const waiting = barrier()
  const settled = barrier()
  const reachedClose = new Error('The initial read has settled')
  const originalRule = () => null
  const proxy = { requests: [], rule: originalRule }
  let ready = false
  const recovery = verifyCachedInitialRecovery({
    control: {
      async command(action: string, selector: string) {
        if (action === 'waitFor' && selector.includes('[aria-busy="false"]')) {
          assert.match(selector, /work-item-task-chat-panel/)
          waiting.release()
          await settled.promise
          ready = true
        }
        if (selector.includes('ai-chat-modal-close')) {
          assert.equal(ready, true, 'Cached text does not prove that the shared read is finished')
          throw reachedClose
        }
      },
    },
    proxy,
    scope: (selector: string) => selector,
    binding: { id: 'bound-task' },
  }).then(
    () => new Error('Expected the close boundary'),
    (error: unknown) => error
  )
  assert.equal(await Promise.race([waiting.promise.then(() => 'waiting'), recovery]), 'waiting')
  assert.equal(proxy.rule, originalRule)
  settled.release()
  assert.equal(await recovery, reachedClose)
})

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}

test('Stand-in confirmation waits for navigation to mount before opening the owner page', async () => {
  const waiting = barrier()
  const mounted = barrier()
  const reachedOwner = new Error('Owner page is ready')
  const calls: Array<{ action: string; selector: string }> = []
  let preferencesReady = false
  const scenario = createDesktopScenario({ workspacePath: '/fixture' })
  const verification = scenario
    .verify({
      async command(action: string, selector: string, options?: { value?: string }) {
        calls.push({ action, selector })
        if (action === 'getElementCount' && selector === '[data-testid="settings-button"]') return 0
        if (action === 'setAppPreferences') {
          assert.equal(selector, 'body')
          assert.deepEqual(JSON.parse(options?.value ?? ''), { experimentalFeaturesEnabled: true })
          preferencesReady = true
        }
        if (selector === '[data-testid="personal-stand-in-button"]') {
          assert.equal(preferencesReady, true, 'Refresh preferences before opening Stand-in')
          if (action === 'click') throw new Error('Stand-in navigation is still mounting')
          assert.equal(action, 'clickWhenEnabled')
          waiting.release()
          await mounted.promise
        }
        if (selector === '[data-testid="stand-in-overview"]') throw reachedOwner
      },
    })
    .then(
      () => new Error('Expected the owner-page boundary'),
      (error: unknown) => error
    )
  assert.equal(await Promise.race([waiting.promise.then(() => 'waiting'), verification]), 'waiting')
  assert.equal(
    calls.some(call => call.selector === '[data-testid="stand-in-overview"]'),
    false
  )
  mounted.release()
  assert.equal(await verification, reachedOwner)
})

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
