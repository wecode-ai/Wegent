import assert from 'node:assert/strict'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { requestExecutor } from './executor-rpc.mjs'

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`

export function createCodexProtocolGate({ resultDir, kind = 'model-list' }) {
  const directory = join(resultDir, `codex-${kind}-gate`)
  const arm = async () => {
    await writeFile(join(directory, 'armed.tmp'), JSON.stringify({ kind }))
    await rename(join(directory, 'armed.tmp'), join(directory, 'armed'))
  }
  const release = () => writeFile(join(directory, 'released'), '')
  const wait = async () => {
    const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await readFile(join(directory, 'held.json'), 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.fail(`Real Codex never reached the ${kind} protocol barrier`)
  }
  return {
    arm,
    wait,
    release,
    async prepareApp({ appEnvironment }) {
      await mkdir(directory, { recursive: true })
      const relay = fileURLToPath(new URL('./codex-stdio-gate-process.mjs', import.meta.url))
      const wrapper = join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex')
      const windowsQuote = value => `"${value.replaceAll('%', '%%')}"`
      const launcher =
        process.platform === 'win32'
          ? `@echo off\r\n${[process.execPath, relay, appEnvironment.CODEX_BINARY_PATH, directory].map(windowsQuote).join(' ')} %*\r\n`
          : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(relay)} ${shellQuote(appEnvironment.CODEX_BINARY_PATH)} ${shellQuote(directory)} "$@"\n`
      await writeFile(wrapper, launcher, { mode: 0o755 })
      appEnvironment.CODEX_BINARY_PATH = wrapper
      appEnvironment.CODEX_BIN = wrapper
    },
    async verifyOverlap(control) {
      await arm()
      const discovery = requestExecutor(
        control,
        'runtime.codex.models.list',
        { includeHidden: true },
        DEFAULT_STEP_TIMEOUT_MS
      )
      const held = await wait()
      let restartSettled = false
      let restartCompletedAt
      let releasedAt
      const logPath = join(resultDir, 'executor.log')
      const offset = (await readFile(logPath, 'utf8')).length
      const restartRequestedAt = Date.now()
      const restart = requestExecutor(
        control,
        'runtime.codex.app_server.restart',
        { ifIdle: true },
        DEFAULT_STEP_TIMEOUT_MS
      ).finally(() => {
        restartSettled = true
        restartCompletedAt = Date.now()
      })
      try {
        const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
        let started = false
        while (Date.now() < deadline && !started) {
          started = /app IPC request started .*method=runtime\.codex\.app_server\.restart/.test(
            (await readFile(logPath, 'utf8')).slice(offset)
          )
          if (!started) await new Promise(resolve => setTimeout(resolve, 25))
        }
        assert.ok(started, 'Catalog restart did not overlap the held native discovery')
        // The native discovery remains pending while the restart request reaches the Executor.
        await new Promise(resolve => setTimeout(resolve, 100))
        assert.equal(
          restartSettled,
          false,
          'Idle catalog restart bypassed the pending discovery gate'
        )
      } finally {
        releasedAt = Date.now()
        await release()
      }
      const [models, restarted] = await Promise.all([discovery, restart])
      assert.equal(restarted.restarted, true, JSON.stringify(restarted))
      assert.equal(
        restarted.requiresConfirmation,
        false,
        'An idle discovery was mistaken for active work'
      )
      assert.ok(models.data?.length > 0, 'Overlapping model discovery did not complete')
      await writeFile(
        join(resultDir, 'codex-discovery-race.json'),
        JSON.stringify(
          {
            held,
            restartRequestedAt,
            releasedAt,
            restartCompletedAt,
            restarted,
            discoveredIds: models.data.map(model => model.id),
          },
          null,
          2
        )
      )
    },
  }
}
