import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const MAX_VALUE_LENGTH = 128
const SMART_APP_SOURCES = new Set(['managed', 'linked', 'market'])

export function createSmartAppRegistry({ dshHome = process.env.DSH_HOME, read = readFile } = {}) {
  const registryPath = createRegistryPath(dshHome)

  return Object.freeze({
    async find(installationId) {
      if (!registryPath || !boundedString(installationId)) return null

      let installations
      try {
        installations = JSON.parse(await read(registryPath, 'utf8'))
      } catch {
        return null
      }
      if (!Array.isArray(installations)) return null

      const installation = installations.find(entry => entry?.id === installationId)
      return projectInstallation(installation)
    },
  })
}

function createRegistryPath(dshHome) {
  if (typeof dshHome !== 'string' || dshHome.trim() === '') return null
  return join(dirname(dshHome), 'harness-apps', 'installations.json')
}

function projectInstallation(installation) {
  const manifest = installation?.manifest
  if (
    !boundedString(manifest?.name) ||
    !boundedString(manifest?.version) ||
    !SMART_APP_SOURCES.has(installation?.source)
  ) {
    return null
  }

  const name = boundedString(manifest.displayName) ? manifest.displayName : manifest.name
  return {
    key: manifest.name,
    name,
    version: manifest.version,
    source: installation.source,
  }
}

function boundedString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_VALUE_LENGTH
}
