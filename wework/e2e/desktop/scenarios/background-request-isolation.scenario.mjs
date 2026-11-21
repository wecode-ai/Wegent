import assert from 'node:assert/strict'
import {
  ACTIVE_COMPOSER_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'

export function createDesktopScenario({ workspacePath, uiTimeoutMs }) {
  return {
    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'background-request-isolation')
      await selectE2EModel(control)
      const gates = runtimeTransportGates(control)
      try {
        for (let index = 0; index < 4; index++) {
          await gates.arm({
            id: `background-${index}`,
            kind: 'request',
            name: 'runtime.tasks.list',
            where: [{ path: 'params.backgroundProbe', equals: index }],
          })
        }
        await control.command('startBackgroundRequestProbe', 'body')
        await gates.wait('background-0')
        await gates.wait('background-1')
        const probe = JSON.parse(await control.command('readBackgroundRequestProbe', 'body'))
        const background = lock => lock.name.startsWith('wework.dsh.background.')
        assert.equal(probe.locks.held.filter(background).length, 2)
        assert.ok(
          probe.locks.pending.filter(background).length >= 2,
          'Remaining background requests must wait before fetch'
        )
        assert.equal(await gates.read('background-2'), null)
        assert.equal(await gates.read('background-3'), null)

        // Stall the real background transport at admission; native attachment staging stays usable.
        const filename = 'foreground-while-background-stalled.txt'
        await control.command('pasteFile', ACTIVE_COMPOSER_SELECTOR, {
          filename,
          mimeType: 'text/plain',
          value: Buffer.from('foreground attachment').toString('base64'),
        })
        await control.command('waitFor', '[data-testid="attachment-badge"]', {
          text: filename,
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        await gates.release('background-1')
        await gates.wait('background-2')
        await gates.release('background-0')
        await gates.wait('background-3')
        await gates.reset()
        const completed = JSON.parse(
          await control.command('waitForBackgroundRequestProbe', 'body', { timeoutMs: uiTimeoutMs })
        )
        assert.deepEqual(Object.values(completed), ['done', 'done', 'done', 'done'])
      } finally {
        await gates.reset()
      }
    },
  }
}
