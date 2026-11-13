import { requestExecutor } from './executor-rpc.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  currentExecutorPid,
  restartCodexWhenIdle,
  waitForRestartedExecutor,
} from './executor-restart-readiness.mjs'
import { waitForLogPattern } from './shared.mjs'

const loadedCatalogOverrides = new WeakMap()

/** Interrupt a real catalog restart, then reconcile without the failure cooldown. */
export async function verifyModelCatalogRecovery(control, { resultDir, uiTimeoutMs }) {
  if (process.platform === 'win32') return
  await control.command('ensureLocalModelCatalogReady', 'body')
  const original = await control.command('getNativeModelFixtureConfigs', 'body')
  const models = JSON.parse(original)
  const pending = models.filter(model => model.catalogEntry)
  assert.ok(pending.length > 0, 'The recovery fixture needs real custom catalog entries')
  const originalPid = await currentExecutorPid(control)
  assert.ok(originalPid, 'The catalog executor must be running')
  const executorLogPath = join(resultDir, 'executor.log')
  const logOffset = (await readFile(executorLogPath, 'utf8')).length
  const appLogPath = join(resultDir, 'app.log')
  const appLogOffset = (await readFile(appLogPath, 'utf8')).length
  let stopped = false
  try {
    await control.command('holdLocalExecutorRequests', 'body', {
      value: JSON.stringify({
        method: 'runtime.codex.app_server.restart',
        phase: 'before-dispatch',
      }),
    })
    await control.command('setNativeModelFixtureConfigs', 'body', {
      value: JSON.stringify(
        models.map(model =>
          model.catalogEntry
            ? {
                ...model,
                catalogEntry: {
                  ...model.catalogEntry,
                  description: `${model.catalogEntry.description} — E2E interrupted update`,
                },
              }
            : model
        )
      ),
    })
    await control.command('dispatchLocalModelSettingsChanged', 'body')
    const held = JSON.parse(await control.command('awaitLocalExecutorRequestHold', 'body'))
    assert.ok(held.heldCount > 0, 'Catalog writing must reach the real app-server restart')
    process.kill(originalPid, 'SIGSTOP')
    stopped = true
    assert.equal(await control.command('releaseLocalExecutorRequestHold', 'body'), 'true')
    process.kill(originalPid, 'SIGKILL')
    stopped = false
    await waitForLogPattern(appLogPath, /Local model catalog reconciliation failed/, {
      fromOffset: appLogOffset,
      timeoutMs: uiTimeoutMs,
    })
    await waitForRestartedExecutor({
      control,
      originalPid,
      executorLogPath,
      logOffset,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('ensureLocalModelCatalogReady', 'body', { timeoutMs: uiTimeoutMs })
    const restored = JSON.parse(await control.command('getNativeModelFixtureConfigs', 'body'))
    assert.ok(
      pending.every(model => restored.find(row => row.id === model.id)?.catalogReady),
      'The next synchronization must restore every pending catalog entry'
    )
    await writeFile(
      join(resultDir, 'model-catalog-recovery.json'),
      JSON.stringify(
        {
          interrupted: true,
          recoveredModelIds: pending.map(model => model.id),
        },
        null,
        2
      )
    )
  } finally {
    if (stopped) process.kill(originalPid, 'SIGCONT')
    await control.command('releaseLocalExecutorRequestHold', 'body')
  }
}

export async function setNativeCatalogOverride(control, slug, fields, timeoutMs) {
  const rpc = (method, params) => requestExecutor(control, method, params, timeoutMs)
  const catalog = await rpc('runtime.codex.catalog.overrides.read', { slugs: [slug] })
  const model = catalog.models.find(entry => entry.slug === slug)
  assert.ok(model, `Missing native catalog fixture: ${slug}`)
  const loaded = loadedCatalogOverrides.get(control) ?? new Map()
  loadedCatalogOverrides.set(control, loaded)
  const unchanged = Object.entries(fields).every(([key, value]) =>
    isDeepStrictEqual(model.effective[key], value)
  )
  if (unchanged && isDeepStrictEqual(loaded.get(slug), model.effective)) return
  loaded.delete(slug)
  const entry = { ...model.effective, ...fields }
  if (!unchanged) {
    await rpc('runtime.codex.catalog.overrides.write', { slug, entry })
  }
  const restarted = await restartCodexWhenIdle(
    () => rpc('runtime.codex.app_server.restart', { ifIdle: true }),
    timeoutMs
  )
  assert.equal(restarted.restarted, true, JSON.stringify(restarted))
  loaded.set(slug, structuredClone(entry))
}
