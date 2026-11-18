// @vitest-environment node

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { waitForCatalogRestart } from '../../e2e/desktop/scenarios/codex-catalog-context.mjs'

test('handles a late restart confirmation after native catalog loading finishes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-restart-'))
  const path = join(directory, 'executor.log')
  await writeFile(
    path,
    [
      'app IPC request finished request_id=write method=runtime.codex.catalog.overrides.write elapsed_ms=0 ok=true',
      'app IPC request started request_id=restart method=runtime.codex.app_server.restart',
      'codex router model catalog prepared model_count=1',
      'codex shared app-server process starting process_id=123',
      'codex shared app-server process initialized process_id=123',
      'app IPC request finished request_id=restart method=runtime.codex.app_server.restart elapsed_ms=0 ok=true',
    ].join('\n')
  )
  const snapshots = [
    ['codex-catalog-editor-dialog'],
    ['codex-catalog-editor-dialog', 'local-model-catalog-restart-dialog'],
    [],
  ]
  const command = vi.fn(async (action: string, selector: string) => {
    if (action === 'snapshot') {
      const testIds = snapshots.shift()
      expect(testIds).toBeDefined()
      return JSON.stringify({ testIds })
    }
    expect(action).toBe('clickWhenEnabled')
    expect(selector).toBe('[data-testid="local-model-catalog-restart-now-button"]')
    return ''
  })
  try {
    await waitForCatalogRestart({ command }, path, 0)
    expect(command).toHaveBeenCalledWith(
      'clickWhenEnabled',
      '[data-testid="local-model-catalog-restart-now-button"]'
    )
    expect(snapshots).toHaveLength(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
