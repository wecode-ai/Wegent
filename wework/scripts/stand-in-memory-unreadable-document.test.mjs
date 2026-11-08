import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-memory-unreadable-document.scenario.mjs'
import { memoryVisualPdfFixture } from '../e2e/desktop/modules/stand-in-memory-unreadable-document.mjs'

test('unreadable document memory checkpoint has an independent CI owner', () => {
  const catalog = loadDesktopCheckpointCatalog()
  const name = 'stand-in-memory-unreadable-document'
  assert.ok(catalog.DESKTOP_CHECKPOINTS.includes(name))
  assert.ok(catalog.SCENARIO_ONLY_CHECKPOINTS.has(name))
  assert.equal(catalog.ci.core_shards.filter(shard => shard.split(',').includes(name)).length, 1)
  assert.equal(typeof createDesktopScenario({}).verify, 'function')
})

test('visual PDF fixture has raster operations and exact PDF cross-reference offsets', () => {
  const bytes = memoryVisualPdfFixture()
  const text = bytes.toString()
  assert.ok(text.startsWith('%PDF-1.4'))
  assert.ok(text.includes('/BPC 8 ID abc EI'))
  assert.ok(!text.includes(' Tj') && !text.includes(' Tf'))
  const xref = Number(text.match(/startxref\n(\d+)/)[1])
  assert.equal(bytes.subarray(xref, xref + 4).toString(), 'xref')
  const entries = text.slice(xref).split('\n').slice(3, 7)
  entries.forEach((entry, index) => {
    const offset = Number(entry.slice(0, 10))
    assert.ok(
      bytes
        .subarray(offset)
        .toString()
        .startsWith(`${index + 1} 0 obj`)
    )
  })
})
