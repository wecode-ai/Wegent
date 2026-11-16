import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'vite'
import { dynamicIconImports, iconNames } from 'lucide-react/dynamic.js'
import { lucideIconChunks } from '../vite/lucideIconChunks.ts'

test(
  'production icons retain every namespace and load lazily without one file per icon',
  { timeout: 60_000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-lucide-build-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const entry = join(directory, 'entry.mjs')
    await writeFile(
      entry,
      `
    import { AlarmClock } from 'lucide-react'
    import { dynamicIconImports, iconNames } from 'lucide-react/dynamic.js'
    export { iconNames }
    export const load = name => dynamicIconImports[name]()
    export const matchesStatic = icon => icon.default === AlarmClock
  `
    )
    const config = {
      configFile: false,
      publicDir: false,
      root: fileURLToPath(new URL('..', import.meta.url)),
      logLevel: 'silent',
      resolve: { dedupe: ['react', 'lucide-react'] },
      build: {
        outDir: join(directory, 'output'),
        modulePreload: false,
        minify: false,
        rolldownOptions: {
          input: entry,
          preserveEntrySignatures: 'strict',
          output: { entryFileNames: 'entry.mjs', chunkFileNames: '[name]-[hash].mjs' },
        },
      },
    }
    const baseline = await build({ ...config, build: { ...config.build, write: false } })
    const baselineChunks = baseline.output.filter(item => item.type === 'chunk')
    assert.ok(
      baselineChunks.length > iconNames.length / 2,
      'The control must reproduce per-icon chunks'
    )

    const optimized = await build({ ...config, plugins: [lucideIconChunks()] })
    const chunks = optimized.output.filter(item => item.type === 'chunk')
    assert.ok(
      chunks.length <= 8,
      `Icon file count regressed: baseline=${baselineChunks.length}, actual=${chunks.length}`
    )
    const dynamic = new Set(chunks.flatMap(chunk => chunk.dynamicImports))
    assert.equal(dynamic.size, 1)
    const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]))
    const loaded = new Set()
    const visit = name => {
      if (loaded.has(name)) return
      loaded.add(name)
      for (const dependency of byName.get(name)?.imports ?? []) visit(dependency)
    }
    visit(chunks.find(chunk => chunk.isEntry).fileName)
    assert.ok(!loaded.has([...dynamic][0]), 'The full icon catalog must not load with the entry')

    const actual = await import(pathToFileURL(join(config.build.outDir, 'entry.mjs')).href)
    assert.deepEqual(actual.iconNames, iconNames)
    assert.equal(actual.matchesStatic(await actual.load('alarm-clock')), true)
    for (const name of iconNames) {
      const expected = await dynamicIconImports[name]()
      const icon = await actual.load(name)
      assert.deepEqual(icon.__iconNode, expected.__iconNode, name)
      assert.equal(icon.default.displayName, expected.default.displayName, name)
    }
  }
)
