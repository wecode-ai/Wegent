import assert from 'node:assert/strict'

const STORAGE_ENTRIES = {
  'wework.e2e.renderer-storage.model': 'model-config',
  'wework.e2e.renderer-storage.draft': 'unsaved-draft',
  'wework.e2e.renderer-storage.layout': 'layout-state',
}

export async function createDesktopScenario({ uiTimeoutMs }) {
  return {
    async verify(control) {
      await control.command('snapshot', 'body')
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
      for (const [key, value] of Object.entries(STORAGE_ENTRIES)) {
        assert.equal(
          await control.command('getLocalStorageItem', 'body', { value: key }),
          value,
          `Renderer storage key ${key} was lost after the DSH origin changed`
        )
        await control.command('removeLocalStorageItem', 'body', { value: key })
      }
    },

    diagnostics() {
      return { rendererStorage: true }
    },
  }
}
