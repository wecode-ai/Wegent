import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

export async function readConnectionRuntimeDelivery(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packageRoots))
    throw new Error('Delivered connection service manifest is invalid')
  const path = value => {
    if (typeof value !== 'string' || !value || value.split(/[\\/]/).includes('..'))
      throw new Error('Delivered connection service path is invalid')
    return isAbsolute(value) ? value : resolve(dirname(manifestPath), value)
  }
  return {
    ...manifest,
    runtimeRoot: path(manifest.runtimeRoot),
    nodeExecutable: path(manifest.nodeExecutable),
    packageRoots: manifest.packageRoots.map(path),
  }
}
