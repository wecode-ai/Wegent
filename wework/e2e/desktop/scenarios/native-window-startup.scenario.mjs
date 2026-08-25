import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function createDesktopScenario({ resultDir }) {
  return {
    async verify(control) {
      const snapshot = JSON.parse(
        await control.command('getStartupSplashSnapshot', 'body')
      )
      assert.equal(snapshot.state, 'closed', 'The Electron startup splash was not closed')
      assert.deepEqual(
        snapshot.events.map(event => event.name),
        ['created', 'shown', 'animation-ready', 'closed'],
        'The Electron startup splash did not complete its animated lifecycle'
      )
      const image = await readFile(join(resultDir, 'startup-splash.png'))
      assert.ok(image.length > 8, 'The Electron startup splash capture was empty')
      assert.equal(
        image.subarray(1, 4).toString('ascii'),
        'PNG',
        'The Electron startup splash evidence was not a PNG'
      )
    },

    diagnostics() {
      return { nativeWindowStartup: true }
    },
  }
}
