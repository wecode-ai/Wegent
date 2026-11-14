import { expect, test, vi } from 'vitest'

import { resolveElectronBinary } from '../../e2e/desktop/modules/electron-binary.mjs'

test('uses the configured Electron binary without reading the npm package config', () => {
  const resolveInstalledBinary = vi.fn(() => {
    throw new Error('The npm package resolver must not run')
  })

  expect(
    resolveElectronBinary({
      configuredBinary: String.raw`C:\deps\electron\dist\electron.exe`,
      resolveInstalledBinary,
    })
  ).toBe(String.raw`C:\deps\electron\dist\electron.exe`)
  expect(resolveInstalledBinary).not.toHaveBeenCalled()
})

test('resolves the installed Electron package when no binary is configured', () => {
  const resolveInstalledBinary = vi.fn(() => '/deps/electron/dist/electron')

  expect(
    resolveElectronBinary({
      configuredBinary: '',
      resolveInstalledBinary,
    })
  ).toBe('/deps/electron/dist/electron')
  expect(resolveInstalledBinary).toHaveBeenCalledOnce()
})
