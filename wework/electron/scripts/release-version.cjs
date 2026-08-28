const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function resolveReleaseVersion(defaultVersion, environment = process.env) {
  const configuredVersion = environment.WEWORK_RELEASE_VERSION?.trim()
  const version = configuredVersion || defaultVersion?.trim()
  if (!version || !RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid Wework release version: ${version || '<empty>'}`)
  }
  return version
}

module.exports = {
  RELEASE_VERSION_PATTERN,
  resolveReleaseVersion,
}
