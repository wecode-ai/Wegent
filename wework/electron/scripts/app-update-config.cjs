const DEFAULT_UPDATE_BASE_URL =
  'https://github.com/wecode-ai/Wegent/releases/download/wework-updater'

function resolveAppUpdateConfiguration(packageName, environment = process.env) {
  const updateBaseUrl = (
    environment.WEWORK_UPDATE_BASE_URL?.trim() || DEFAULT_UPDATE_BASE_URL
  ).replace(/\/+$/, '')
  const parsed = new URL(updateBaseUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('WEWORK_UPDATE_BASE_URL must be an HTTP(S) URL without credentials')
  }

  const sanitizedPackageName = packageName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\.+$/, '')
    .trim()
  if (!sanitizedPackageName) {
    throw new Error('Electron package name cannot produce an updater cache directory')
  }

  return {
    provider: 'generic',
    url: updateBaseUrl,
    updaterCacheDirName: `${sanitizedPackageName.toLowerCase()}-updater`,
  }
}

function serializeAppUpdateConfiguration(configuration) {
  return [
    `provider: ${configuration.provider}`,
    `url: ${JSON.stringify(configuration.url)}`,
    `updaterCacheDirName: ${JSON.stringify(configuration.updaterCacheDirName)}`,
    '',
  ].join('\n')
}

module.exports = {
  DEFAULT_UPDATE_BASE_URL,
  resolveAppUpdateConfiguration,
  serializeAppUpdateConfiguration,
}
