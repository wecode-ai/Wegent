import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import {
  disableAmbientAsarInterception,
  restoreAmbientAsarInterception,
} from '../src/runtime/ambient-asar-fixtures.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const { PnpmNodeModulesCollector } = builderRequire(
  'app-builder-lib/out/node-module-collector/pnpmNodeModulesCollector.js'
)
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const asar = appBuilderRequire('@electron/asar')
const builderConfig = require('../electron-builder.config.cjs')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
disableAmbientAsarInterception()
afterAll(restoreAmbientAsarInterception)

test('declares every supported CUA native package at the driver version', async () => {
  const driver = JSON.parse(
    await readFile(join(root, 'node_modules/@trycua/cua-driver/package.json'), 'utf8')
  )
  const native = Object.entries(driver.optionalDependencies).filter(([name]) =>
    name.startsWith('@trycua/cua-driver-')
  )
  expect(native).toHaveLength(6)
  for (const [name, version] of native) {
    expect(manifest.optionalDependencies[name]).toBe(version)
    expect(version).toBe(manifest.dependencies['@trycua/cua-driver'])
  }
})

test('electron-builder collects the installed native package and library', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-cua-collector-'))
  let index = 0
  try {
    const collector = new PnpmNodeModulesCollector(root, {
      getTempFile: async () => join(directory, `${index++}.txt`),
    })
    const { nodeModules: modules } = await collector.getNodeModules({ packageName: manifest.name })
    const suffix =
      process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : ''
    const name = `@trycua/cua-driver-${process.platform}-${process.arch}${suffix}`
    const flatten = entries =>
      entries.flatMap(entry => [entry, ...flatten(entry.dependencies || [])])
    const native = flatten(modules).find(entry => entry.name === name)
    expect(native, `Missing native package: ${name}`).toBeDefined()
    const library =
      process.platform === 'darwin'
        ? 'libcua_driver_sdk.dylib'
        : process.platform === 'win32'
          ? 'cua_driver_sdk.dll'
          : 'libcua_driver_sdk.so'
    const payload = join(directory, 'payload')
    const packagePath = join('node_modules', name)
    await mkdir(join(payload, 'node_modules', '@trycua'), { recursive: true })
    await cp(native.dir, join(payload, packagePath), { recursive: true })
    const archive = join(directory, 'app.asar')
    await asar.createPackageWithOptions(payload, archive, { unpack: builderConfig.asarUnpack[0] })
    for (const filename of [library, 'cua_driver_node_runtime.node']) {
      expect(asar.statFile(archive, join(packagePath, filename)).unpacked).toBe(true)
      expect((await stat(join(archive + '.unpacked', packagePath, filename))).size).toBeGreaterThan(
        0
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
