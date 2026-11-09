import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createDirectRecoveryVerification } from '../e2e/desktop/modules/stand-in-direct-recovery.mjs'

afterEach(() => vi.unstubAllEnvs())

test('shared CLI recovery reuses its prepared fixture without a compiler in the user PATH', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'dingtalk-recovery-'))
  try {
    const prepared = join(resultDir, 'prepared.exe')
    await writeFile(prepared, 'prepared recovery protocol')
    vi.stubEnv('WEWORK_E2E_DWS_RECOVERY_FIXTURE_BIN', prepared)
    vi.stubEnv('PATH', '')
    const executorHome = join(resultDir, 'executor')
    const context = { appEnvironment: { DWS_BINARY_PATH: '/prepared/previous-fixture' } }
    await createDirectRecoveryVerification({
      resultDir,
      executorHome,
      workspacePath: resultDir,
    }).prepareApp(context)
    expect(await readFile(context.appEnvironment.DWS_BINARY_PATH, 'utf8')).toBe(
      'prepared recovery protocol'
    )
    expect(await readFile(join(resultDir, 'direct-recovery/baseline-path.txt'), 'utf8')).toBe(
      '/prepared/previous-fixture'
    )
    const index = JSON.parse(await readFile(join(executorHome, 'runtime-work/index.json'), 'utf8'))
    expect(index.tasks['stand-in-coordinator-9001'].thread_id).toBeNull()
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})
