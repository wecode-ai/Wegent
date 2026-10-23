import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = ts.readConfigFile(resolve(root, 'tsconfig.app.json'), ts.sys.readFile)
assert.equal(config.error, undefined)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
assert.deepEqual(parsed.errors, [])

const sources = [
  resolve(root, 'src/App.tsx'),
  resolve(root, '../shared/assets/codex-models/kimi.json'),
  realpathSync(require.resolve('react-i18next')),
]

for (const source of sources) {
  test(`React types stay local when resolving from ${source}`, () => {
    for (const [name, declaration] of [
      ['react', 'index.d.ts'],
      ['react/jsx-runtime', 'jsx-runtime.d.ts'],
    ]) {
      const result = ts.resolveModuleName(name, source, parsed.options, ts.sys)
      assert.ok(result.resolvedModule, `${name} must resolve`)
      assert.equal(
        realpathSync(result.resolvedModule.resolvedFileName),
        realpathSync(resolve(root, 'node_modules/@types/react', declaration))
      )
    }
  })
}
