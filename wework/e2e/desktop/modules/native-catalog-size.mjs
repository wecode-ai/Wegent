import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'

/** Exercise a large aggregate catalog while respecting the per-request RPC budget. */
export async function verifyLargeNativeCatalog(control, baselines, timeoutMs) {
  const marker = 'WEWORK_E2E_LARGE_NATIVE_CATALOG'
  assert.equal(baselines.length, 2)
  const entries = baselines.map((baseline, index) => ({
    ...baseline,
    display_name: `${marker}_${index}`,
    base_instructions: `${marker}\n${baseline.base_instructions.repeat(
      Math.ceil(600_000 / Math.max(1, baseline.base_instructions.length))
    )}`,
  }))
  const instructionBytes = entries.reduce(
    (total, entry) => total + Buffer.byteLength(entry.base_instructions),
    0
  )
  assert.ok(instructionBytes > 1_048_576)
  const rpc = (method, params) => requestExecutor(control, method, params, timeoutMs)
  try {
    for (const entry of entries) {
      const params = { slug: entry.slug, entry }
      assert.ok(Buffer.byteLength(JSON.stringify(params)) < 900_000)
      await rpc('runtime.codex.catalog.overrides.write', params)
    }
    const restarted = await rpc('runtime.codex.app_server.restart', { ifIdle: true })
    assert.equal(restarted.restarted, true, JSON.stringify(restarted))
    const models = await rpc('runtime.codex.models.list', { includeHidden: true })
    for (const entry of entries) {
      assert.equal(
        models.data.find(model => model.id === entry.slug)?.displayName,
        entry.display_name,
        'Real Codex discarded the complete model catalog above the custom-URL limit'
      )
    }
    console.info('[native-catalog-size]', JSON.stringify({ instructionBytes }))
  } finally {
    for (const entry of entries) {
      await rpc('runtime.codex.catalog.overrides.delete', { slug: entry.slug })
    }
    await rpc('runtime.codex.app_server.restart', { ifIdle: true })
  }
}
