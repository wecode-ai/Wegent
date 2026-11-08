import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import JSZip from 'jszip'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-memory-document.scenario.mjs'
import {
  memoryDocumentFixture,
  DOCUMENT_FACT,
  DOCUMENT_TEXT,
} from '../e2e/desktop/modules/stand-in-memory-document.mjs'

test('native document memory checkpoint runs independently in existing core CI', () => {
  const catalog = loadDesktopCheckpointCatalog()
  const name = 'stand-in-memory-document'
  assert.ok(catalog.DESKTOP_CHECKPOINTS.includes(name))
  assert.ok(catalog.SCENARIO_ONLY_CHECKPOINTS.has(name))
  assert.ok(catalog.ci.core_segments.includes(name))
  assert.equal(catalog.ci.core_shards.filter(shard => shard.split(',').includes(name)).length, 1)
  assert.equal(
    catalog.CHECKPOINT_SCENARIO_MODULES[name],
    './scenarios/stand-in-memory-document.scenario.mjs'
  )
  const scenario = createDesktopScenario({ uiTimeoutMs: 10000, modelResponseTimeoutMs: 30000 })
  assert.equal(typeof scenario.verify, 'function')
  assert.equal(typeof scenario.handleHttp, 'function')
})

test('Word fixture binds original compressed bytes and places the fact after the first chunk', async () => {
  const { bytes, hash } = await memoryDocumentFixture()
  assert.equal(hash, createHash('sha256').update(bytes).digest('hex'))
  const zip = await JSZip.loadAsync(bytes)
  assert.ok(zip.file('[Content_Types].xml'))
  const xml = await zip.file('word/document.xml').async('string')
  assert.ok(xml.includes(DOCUMENT_TEXT))
  assert.ok(Buffer.byteLength(DOCUMENT_TEXT.split(DOCUMENT_FACT)[0]) > 8192)
  assert.ok(Buffer.byteLength(DOCUMENT_TEXT) < 16384)
  assert.ok(bytes.length < 8 * 1024 * 1024)
})
