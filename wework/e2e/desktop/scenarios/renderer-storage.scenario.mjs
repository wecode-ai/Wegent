import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyPerformanceRecording } from '../modules/performance-recording.mjs'

import { verifyWorkbenchBackgroundSurfaces } from '../modules/appearance-flows.mjs'
import { ACTIVE_COMPOSER_SELECTOR } from '../modules/shared.mjs'

const STORAGE_ENTRIES = {
  'wework.e2e.renderer-storage.model': 'model-config',
  'wework.e2e.renderer-storage.draft': 'unsaved-draft',
  'wework.e2e.renderer-storage.layout': 'layout-state',
}
const UNSENT_DRAFT = 'WEWORK_RENDERER_STORAGE_UNSENT_DRAFT'

async function verifyComposerDraftRecovery({ control, restartDesktopApp, uiTimeoutMs }) {
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: UNSENT_DRAFT })
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    text: UNSENT_DRAFT,
    stableMs: 500,
    timeoutMs: uiTimeoutMs,
  })

  await restartDesktopApp({ forceStop: true })
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    visible: true,
    text: UNSENT_DRAFT,
    stableMs: 500,
    timeoutMs: uiTimeoutMs,
  })
  assert.equal(
    await control.command('getValue', ACTIVE_COMPOSER_SELECTOR),
    UNSENT_DRAFT,
    'The active blank-chat draft was not restored after a forced restart'
  )
  await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: '' })
}

export async function createDesktopScenario({
  electronUserDataDirectory,
  restartDesktopApp,
  uiTimeoutMs,
}) {
  const originStatePath = join(electronUserDataDirectory, 'renderer-local-storage-origins.json')

  return {
    async verify(control) {
      await control.command('snapshot', 'body')
      await verifyWorkbenchBackgroundSurfaces({ control })
      await verifyComposerDraftRecovery({ control, restartDesktopApp, uiTimeoutMs })

      const originBeforeRestart = await control.command('getLocationOrigin', 'body')
      for (const [key, value] of Object.entries(STORAGE_ENTRIES)) {
        assert.equal(
          await control.command('setLocalStorageItem', 'body', {
            value: JSON.stringify({ key, value }),
          }),
          value,
          `Failed to seed renderer storage key ${key}`
        )
      }

      const readyCountBeforeRestart = control.readyCount
      await control.command('restartCoreDsh', 'body')
      await control.awaitReadyAfter(readyCountBeforeRestart)
      await control.command('waitFor', 'body', {
        timeoutMs: uiTimeoutMs,
        stableMs: 300,
      })

      const originAfterRestart = await control.command('getLocationOrigin', 'body')
      assert.notEqual(
        originAfterRestart,
        originBeforeRestart,
        'The Core DSH restart reused the previous origin and did not exercise storage migration'
      )
      assert.deepEqual(JSON.parse(await readFile(originStatePath, 'utf8')), {
        version: 1,
        origins: [originAfterRestart],
      })

      const readyCountBeforeSecondRestart = control.readyCount
      await control.command('restartCoreDsh', 'body')
      await control.awaitReadyAfter(readyCountBeforeSecondRestart)
      await control.command('waitFor', 'body', {
        timeoutMs: uiTimeoutMs,
        stableMs: 300,
      })

      const originAfterSecondRestart = await control.command('getLocationOrigin', 'body')
      assert.notEqual(
        originAfterSecondRestart,
        originAfterRestart,
        'The second Core DSH restart reused the previous origin'
      )
      assert.deepEqual(JSON.parse(await readFile(originStatePath, 'utf8')), {
        version: 1,
        origins: [originAfterSecondRestart],
      })
      for (const [key, value] of Object.entries(STORAGE_ENTRIES)) {
        assert.equal(
          await control.command('getLocalStorageItem', 'body', { value: key }),
          value,
          `Renderer storage key ${key} was lost after the DSH origin changed`
        )
        await control.command('removeLocalStorageItem', 'body', { value: key })
      }

      await verifyPerformanceRecording(control, {
        electronUserDataDirectory,
        restartDesktopApp,
        uiTimeoutMs,
      })
    },

    diagnostics() {
      return { rendererStorage: true }
    },
  }
}
