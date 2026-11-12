import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfigFromFile } from 'vite'
import { BaseSequencer } from 'vitest/node'

test('the real Vitest configuration supplies a constructor and retains exact shard coverage', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const previous = process.env.WEWORK_CI_BALANCED_SHARDS
  try {
    for (const enabled of [false, true]) {
      process.env.WEWORK_CI_BALANCED_SHARDS = String(enabled)
      const result = await loadConfigFromFile(
        { command: 'serve', mode: 'test' },
        resolve(root, 'vitest.config.ts'),
        root
      )
      assert.ok(result, 'The real Vitest configuration must load')
      const sequence = result.config.test.sequence
      if (!enabled) {
        assert.equal(sequence, undefined)
        continue
      }
      const Sequencer = sequence.sequencer
      assert.equal(typeof Sequencer, 'function')
      assert.ok(Sequencer.prototype instanceof BaseSequencer)
      const files = Array.from({ length: 17 }, (_, index) => ({
        moduleId: resolve(root, `src/fixture-${index}.test.ts`),
      }))
      const shards = await Promise.all(
        [1, 2].map(index =>
          new Sequencer({ config: { root, shard: { index, count: 2 } } }).shard(files)
        )
      )
      assert.deepEqual(new Set(shards.flat()), new Set(files))
      assert.equal(shards.flat().length, files.length)
      assert.equal(await new Sequencer({ config: { root } }).shard(files), files)
    }
  } finally {
    if (previous === undefined) delete process.env.WEWORK_CI_BALANCED_SHARDS
    else process.env.WEWORK_CI_BALANCED_SHARDS = previous
  }
})
