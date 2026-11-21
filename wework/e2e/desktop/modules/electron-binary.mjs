import { createRequire } from 'node:module'

export function resolveElectronBinary({
  configuredBinary = process.env.WEWORK_E2E_ELECTRON_BIN,
  resolveInstalledBinary = () =>
    createRequire(new URL('../../../electron/package.json', import.meta.url))('electron'),
} = {}) {
  return configuredBinary || resolveInstalledBinary()
}
