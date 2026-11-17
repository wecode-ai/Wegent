import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reupgradeAfterRollback } from '../e2e/desktop/modules/reupgrade-after-rollback.mjs'

test('a source without explicit retry consent cannot start re-upgrade', async () => {
  const commands = []
  await assert.rejects(
    reupgradeAfterRollback({
      version: '1.1.0',
      async routeCurrentUpdateRequests() {},
      async about() {},
      control: {
        async command(name, selector) {
          commands.push({ name, selector })
          if (name === 'clickWhenEnabled') return '1.1.0'
          if (name === 'getAppUpdateProgress') return '{}'
          assert.fail(`Unexpected command after missing consent: ${name}`)
        },
      },
      async installedVersion() {
        assert.fail('Must not restart without consent')
      },
    }),
    /requires explicit consent/
  )
  assert.deepEqual(
    commands.map(command => command.name),
    ['clickWhenEnabled', 'getAppUpdateProgress']
  )
})
