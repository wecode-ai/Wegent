import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export async function resolveDesktopPackageLayout(appBinary, platform = process.platform) {
  const launchBinary = resolve(appBinary)
  if (platform === 'darwin') {
    return {
      launchBinary,
      versionBinary: launchBinary,
      resourcesRoot: resolve(launchBinary, '..', '..', 'Resources'),
    }
  }
  const installRoot = dirname(launchBinary)
  let state
  let stateSource
  for (const name of ['update-state.json', 'initial-update-state.json']) {
    try {
      state = JSON.parse(await readFile(join(installRoot, name), 'utf8'))
      stateSource = name
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (!stateSource) {
    return {
      launchBinary,
      versionBinary: launchBinary,
      resourcesRoot: join(installRoot, 'resources'),
    }
  }
  assert.equal(platform, 'win32', 'Versioned desktop installation requires Windows')
  assert.equal(state.schemaVersion, 2, 'Unsupported desktop installation state')
  assert.match(state.active?.path ?? '', /^versions\/[A-Za-z0-9.+_-]+$/)
  const versionBinary = join(installRoot, state.active.path, 'WeWork.exe')
  return {
    installRoot,
    launchBinary,
    resourcesRoot: join(dirname(versionBinary), 'resources'),
    state,
    stateSource,
    versionBinary,
  }
}
