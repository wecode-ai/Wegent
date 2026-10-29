import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { until } from './plugin-regression-fixture.mjs'
import { WORKBENCH_READY_TIMEOUT_MS, waitForLogPattern } from './shared.mjs'

const execute = promisify(execFile)

// Suspend only the real child of this isolated executor; never substitute a native process.
export async function verifyCodexConfigRestart({ control, executorLogPath, configPath }) {
  if (process.platform === 'win32') return
  const origin = await control.command('getLocationOrigin', 'body')
  const rpc = async (method, params, signal) =>
    (
      await fetch(`${origin}/wework/executor/v1/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'config-restart-regression', method, params }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(WORKBENCH_READY_TIMEOUT_MS)])
          : AbortSignal.timeout(WORKBENCH_READY_TIMEOUT_MS),
      })
    ).json()
  const native = (params, signal) => rpc('runtime.codex.app_server.request', params, signal)
  const before = await native({ method: 'config/read', params: { includeLayers: true } })
  assert.equal(before.ok, true)
  const originalEffort = before.result.config.model_reasoning_effort ?? null
  const diagnostics = JSON.parse(await control.command('getDesktopRuntimeDiagnostics', 'body'))

  for (const mode of ['manual', 'proxy', 'cancelled', 'rejected']) {
    await rpc('runtime.codex.ensure_started', {})
    const log = await readFile(executorLogPath, 'utf8')
    const starts = [
      ...log.matchAll(/codex shared app-server process starting[^\n]*process_id=(\d+)/g),
    ]
    const pid = Number(starts.at(-1)?.[1])
    assert.ok(pid > 0, 'The real shared Codex process did not start')
    const status = async () =>
      (await execute('ps', ['-o', 'ppid=,stat=', '-p', String(pid)])).stdout.trim()
    assert.equal(Number((await status()).split(/\s+/)[0]), Number(diagnostics.executorPid))
    const offset = log.length
    const writeMethod = mode === 'rejected' ? 'config/batchWrite' : 'config/value/write'
    const edit = { keyPath: 'model_reasoning_effort', value: 'medium', mergeStrategy: 'replace' }
    const controller = new AbortController()
    const writeController = new AbortController()
    const operations = []
    let resumed = false
    const resume = () => {
      if (resumed) return
      resumed = true
      try {
        process.kill(pid, 'SIGCONT')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    try {
      process.kill(pid, 'SIGSTOP')
      await until(status, value => /\bT/.test(value), 'Codex did not enter the stopped state')
      const write = native(
        {
          method: writeMethod,
          params:
            mode === 'rejected' ? { edits: [edit], expectedVersion: 'stale-e2e-version' } : edit,
        },
        writeController.signal
      )
      operations.push(write)
      // Attach rejection handlers immediately, including on assertion and cancellation paths.
      void write.catch(() => {})
      await waitForLogPattern(executorLogPath, new RegExp(`method=${writeMethod} phase=before`), {
        fromOffset: offset,
      })
      let restarted = false
      const restart = rpc(
        'runtime.codex.app_server.restart',
        { force: true, ...(mode === 'proxy' ? { proxyUrl: 'http://127.0.0.1:9' } : {}) },
        controller.signal
      ).then(response => {
        restarted = true
        return response
      })
      operations.push(restart)
      void restart.catch(() => {})
      await waitForLogPattern(executorLogPath, /method=process\/stop phase=before/, {
        fromOffset: offset,
      })
      assert.equal(restarted, false, `${mode} restart completed before the native write`)
      assert.match(await status(), /\bT/, 'Restart killed the native writer before it completed')
      if (mode === 'cancelled') writeController.abort()
      resume()
      if (mode === 'cancelled') await assert.rejects(write, { name: 'AbortError' })
      else {
        const result = await write
        assert.equal(result.ok, mode !== 'rejected')
        if (mode === 'rejected') assert.match(result.error.message, /version|conflict|modified/i)
      }
      assert.equal((await restart).result.restarted, true)
      // Reset the runtime proxy before asking the real model to complete a turn.
      if (mode === 'proxy') {
        assert.equal(
          (await rpc('runtime.codex.app_server.restart', { force: true, proxyUrl: null })).ok,
          true
        )
      }
      const loaded = await native({ method: 'config/read', params: { includeLayers: true } })
      assert.equal(loaded.ok, true)
      assert.equal(loaded.result.config.model_reasoning_effort, 'medium')
      assert.equal(loaded.result.config.model, before.result.config.model)
      assert.ok((await readFile(configPath, 'utf8')).includes('model_reasoning_effort'))
    } finally {
      try {
        resume()
      } finally {
        controller.abort()
        writeController.abort()
        await Promise.allSettled(operations)
      }
    }
  }
  const restored = await native({
    method: 'config/value/write',
    params: { keyPath: 'model_reasoning_effort', value: originalEffort, mergeStrategy: 'replace' },
  })
  assert.equal(restored.ok, true)
}
