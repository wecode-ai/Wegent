import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { waitForCatalogRestart } from '../e2e/desktop/scenarios/codex-catalog-context.mjs'

test.each(['write', 'delete'])(
  'confirms a pending Catalog %s restart before waiting for editor dismissal',
  async operation => {
    const root = await mkdtemp(join(tmpdir(), 'catalog-restart-'))
    const log = join(root, 'executor.log')
    const persisted = `app IPC request finished request_id=save method=runtime.codex.catalog.overrides.${operation} ok=true\n`
    let confirmed = false
    await writeFile(log, persisted)
    try {
      await waitForCatalogRestart(
        {
          async command(action, selector) {
            if (action === 'snapshot')
              return JSON.stringify({
                testIds: confirmed ? [] : ['local-model-catalog-restart-dialog'],
                text: 'Restart confirmation',
              })
            assert.equal(action, 'clickWhenEnabled')
            assert.equal(selector, '[data-testid="local-model-catalog-restart-now-button"]')
            confirmed = true
            await writeFile(
              log,
              persisted +
                [
                  'app IPC request started request_id=restart method=runtime.codex.app_server.restart',
                  'codex shared app-server process starting ',
                  'codex router model catalog served ',
                  'app IPC request finished request_id=restart method=runtime.codex.app_server.restart ok=true',
                  '',
                ].join('\n')
            )
            return ''
          },
        },
        log,
        0
      )
      assert.equal(confirmed, true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
