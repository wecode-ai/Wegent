import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { waitForCatalogRestart } from '../../e2e/desktop/scenarios/codex-catalog-context.mjs'

let directory: string
let logPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'catalog-restart-'))
  logPath = join(directory, 'executor.log')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

const mutationLog = (operation: string) =>
  `app IPC request finished request_id=change method=runtime.codex.catalog.overrides.${operation} elapsed_ms=8 ok=true\n`
const restartLog = [
  'app IPC request started request_id=restart method=runtime.codex.app_server.restart',
  'codex shared app-server process starting process_id=123',
  'codex router model catalog served model_count=44',
  'app IPC request finished request_id=restart method=runtime.codex.app_server.restart elapsed_ms=35 ok=true',
].join('\n')

test.each(['write', 'delete'])('verifies an idle restart after catalog %s', async operation => {
  const previousLog = 'Earlier restart evidence must be excluded\n'
  await writeFile(logPath, previousLog + mutationLog(operation) + restartLog)
  const command = vi.fn(async () => JSON.stringify({ testIds: [], text: '' }))

  await waitForCatalogRestart({ command }, logPath, previousLog.length)

  expect(command).toHaveBeenCalledExactlyOnceWith('snapshot', 'body')
})

test('confirms a busy restart once before waiting for the editor to close', async () => {
  await writeFile(logPath, mutationLog('write'))
  let snapshots = 0
  const command = vi.fn(async (action: string, selector: string) => {
    if (action === 'clickWhenEnabled') {
      expect(selector).toBe('[data-testid="local-model-catalog-restart-now-button"]')
      await writeFile(logPath, mutationLog('write') + restartLog)
      return undefined
    }
    expect(action).toBe('snapshot')
    snapshots += 1
    return JSON.stringify({
      testIds: snapshots <= 2 ? ['local-model-catalog-restart-dialog'] : [],
      text: '',
    })
  })

  await waitForCatalogRestart({ command }, logPath, 0)

  expect(command.mock.calls.filter(([action]) => action === 'clickWhenEnabled')).toHaveLength(1)
  expect(snapshots).toBe(3)
})

test('rejects a successful RPC without process and catalog restart evidence', async () => {
  await writeFile(
    logPath,
    mutationLog('write') +
      'app IPC request started request_id=restart method=runtime.codex.app_server.restart\n' +
      'app IPC request finished request_id=restart method=runtime.codex.app_server.restart elapsed_ms=0 ok=true'
  )
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(10_001)
  const command = vi.fn(async () => JSON.stringify({ testIds: [], text: '' }))

  await expect(waitForCatalogRestart({ command }, logPath, 0)).rejects.toThrow(
    'The saved Catalog was not loaded by a restarted Codex app-server'
  )
})

test.each(['codex-catalog-error', 'codex-catalog-editor-error'])(
  'reports visible %s immediately',
  async testId => {
    const command = vi.fn(async () =>
      JSON.stringify({ testIds: [testId], text: 'Catalog mutation failed' })
    )

    await expect(waitForCatalogRestart({ command }, logPath, 0)).rejects.toThrow(
      'Catalog mutation failed'
    )
  }
)
