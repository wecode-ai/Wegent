import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  saveCatalogAndWaitForRestart,
  waitForCatalogRestart,
} from '../e2e/desktop/scenarios/codex-catalog-context.mjs'

const roots = []
const persisted =
  'app IPC request finished request_id=write method=runtime.codex.catalog.overrides.write ok=true\n'
const restarted = [
  'app IPC request started request_id=restart method=runtime.codex.app_server.restart',
  'codex shared app-server process starting pid=123',
  'codex router model catalog served models=1',
  'app IPC request finished request_id=restart method=runtime.codex.app_server.restart ok=true',
  '',
].join('\n')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test.each([false, true])(
  'waits for the native restart before editor closure (busy=%s)',
  async busy => {
    const root = await mkdtemp(join(tmpdir(), 'wework-catalog-restart-'))
    roots.push(root)
    const log = join(root, 'executor.log')
    await writeFile(log, '')
    const calls = []
    let confirmation = false
    let applied = false
    const control = {
      async command(action, selector, options) {
        calls.push({ action, selector })
        if (action === 'snapshot') {
          return JSON.stringify({
            testIds: confirmation ? ['local-model-catalog-restart-dialog'] : [],
            text: 'Catalog editor',
          })
        }
        if (selector === '[data-testid="codex-catalog-editor-save"]') {
          await appendFile(log, persisted)
          confirmation = busy
          if (!busy) {
            await appendFile(log, restarted)
            applied = true
          }
        } else if (selector === '[data-testid="local-model-catalog-restart-now-button"]') {
          expect(confirmation).toBe(true)
          await appendFile(log, restarted)
          applied = true
          confirmation = false
        } else {
          expect(action).toBe('waitFor')
          expect(selector).toBe('[data-testid="codex-catalog-editor-dialog"]')
          expect(options).toEqual({ visible: false })
          expect(applied, 'Do not wait for a modal closure that needs an unanswered restart').toBe(
            true
          )
        }
      },
    }

    await saveCatalogAndWaitForRestart(control, log)

    expect(calls[0].selector).toBe('[data-testid="codex-catalog-editor-save"]')
    expect(calls.at(-1).selector).toBe('[data-testid="codex-catalog-editor-dialog"]')
    expect(calls.filter(call => call.selector.includes('restart-now'))).toHaveLength(busy ? 1 : 0)
    expect(await readFile(log, 'utf8')).toContain(restarted)
  }
)

test('propagates a failed save without waiting for restart or dismissing its editor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-catalog-restart-'))
  roots.push(root)
  const log = join(root, 'executor.log')
  await writeFile(log, '')
  const failure = new Error('Catalog write failed')
  const calls = []

  await expect(
    saveCatalogAndWaitForRestart(
      {
        async command(action, selector) {
          calls.push({ action, selector })
          throw failure
        },
      },
      log
    )
  ).rejects.toBe(failure)
  expect(calls).toEqual([
    { action: 'clickWhenEnabled', selector: '[data-testid="codex-catalog-editor-save"]' },
  ])
})

test('restoring a Catalog requires a fresh restart after its delete IPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-catalog-restore-'))
  roots.push(root)
  const log = join(root, 'executor.log')
  const previous = persisted + restarted
  await writeFile(log, previous)
  let snapshots = 0
  await waitForCatalogRestart(
    {
      async command(action, selector) {
        expect({ action, selector }).toEqual({ action: 'snapshot', selector: 'body' })
        snapshots++
        await appendFile(
          log,
          snapshots === 1 ? persisted.replace('overrides.write', 'overrides.delete') : restarted
        )
        return JSON.stringify({ testIds: [], text: 'Catalog restored' })
      },
    },
    log,
    previous.length
  )
  expect(snapshots).toBe(2)
})
