import { expect, test } from 'vitest'
import { packagedHarnessRuntimeCatalog } from './packaged-harness-runtime.mjs'

test('bundles only the default version while retaining pinned legacy download metadata', () => {
  const legacy = {
    role: 'workbench',
    dshVersion: '0.1.0-rc.8',
    downloadUrl: 'https://github.com/legacy',
    archiveSha256: 'legacy-sha',
  }
  const core = { role: 'core', dshVersion: '0.2.0-rc.2', assetName: 'current.tar.gz' }
  const workbench = { ...core, role: 'workbench' }
  expect(packagedHarnessRuntimeCatalog({ runtimes: [legacy, core, workbench] })).toEqual({
    runtimes: [core, workbench],
    downloadableRuntimes: [legacy],
  })
})

test('rejects ambiguous defaults and missing default Workbench support', () => {
  expect(() => packagedHarnessRuntimeCatalog({ runtimes: [] })).toThrow('Exactly one default')
  expect(() =>
    packagedHarnessRuntimeCatalog({ runtimes: [{ role: 'core', dshVersion: '1.0.0' }] })
  ).toThrow('must support Workbench')
})
