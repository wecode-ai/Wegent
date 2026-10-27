const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/
const HASH = /^[a-f0-9]{64}$/

export function compareVersions(left, right) {
  const parts = value => {
    const match = VERSION.exec(value)
    if (!match) throw new Error(`Unsupported Wework version: ${value}`)
    return [...match.slice(1, 4).map(Number), match[4] ? 0 : 1, Number(match[4] ?? 0)]
  }
  const a = parts(left)
  const b = parts(right)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}

export function validateUpgradeCatalog(input) {
  if (
    !input ||
    input.schemaVersion !== 1 ||
    !['stable', 'beta'].includes(input.channel) ||
    !['macos', 'windows', 'linux'].includes(input.platform) ||
    !['arm64', 'x64'].includes(input.arch) ||
    !Array.isArray(input.releases) ||
    !Array.isArray(input.edges)
  ) {
    throw new Error('Invalid Wework upgrade catalog')
  }
  const versions = new Map()
  for (const release of input.releases) {
    compareVersions(release.version, release.minSourceVersion)
    if (
      compareVersions(release.minSourceVersion, release.version) > 0 ||
      versions.has(release.version) ||
      typeof release.revoked !== 'boolean' ||
      !HASH.test(release.sha256) ||
      !Number.isSafeInteger(release.bytes) ||
      release.bytes <= 0 ||
      !Number.isSafeInteger(release.dataSchema) ||
      release.dataSchema < 1 ||
      !Array.isArray(release.readableDataSchemas) ||
      !release.readableDataSchemas.every(v => Number.isSafeInteger(v) && v > 0)
    ) {
      throw new Error('Invalid Wework upgrade release')
    }
    const url = new URL(release.url)
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
    ) {
      throw new Error('Wework upgrade assets require HTTPS')
    }
    versions.set(release.version, release)
  }
  const edges = new Set()
  for (const edge of input.edges) {
    const from = versions.get(edge.from)
    const to = versions.get(edge.to)
    const key = `${edge.from}:${edge.to}`
    if (
      !from ||
      !to ||
      edges.has(key) ||
      compareVersions(edge.from, edge.to) >= 0 ||
      compareVersions(edge.from, to.minSourceVersion) < 0 ||
      typeof edge.revoked !== 'boolean' ||
      edge.fromSha256 !== from.sha256 ||
      edge.toSha256 !== to.sha256 ||
      !/^[0-9]+$/.test(edge.runId) ||
      !HASH.test(edge.evidenceSha256) ||
      edge.upgrade !== 'passed' ||
      edge.rollback !== 'passed'
    ) {
      throw new Error('Invalid or unverified Wework upgrade edge')
    }
    edges.add(key)
  }
  return input
}

/** Only exact tested edges grant upgrade permission. A version range never does. */
export function planUpgrade(catalog, currentVersion) {
  validateUpgradeCatalog(catalog)
  compareVersions(currentVersion, currentVersion)
  const allowed = new Map(catalog.releases.filter(r => !r.revoked).map(r => [r.version, r]))
  const queue = [[currentVersion]]
  const paths = new Map([[currentVersion, []]])
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const path = queue[cursor]
    const from = path.at(-1)
    const next = catalog.edges
      .filter(
        e =>
          !e.revoked &&
          e.from === from &&
          allowed.has(e.to) &&
          (catalog.channel === 'beta' || !e.to.includes('-beta.'))
      )
      .sort((a, b) => compareVersions(b.to, a.to))
    for (const edge of next) {
      if (paths.has(edge.to)) continue
      const nextPath = [...path, edge.to]
      paths.set(edge.to, nextPath.slice(1))
      queue.push(nextPath)
    }
  }
  const destinations = [...paths.keys()]
    .filter(v => v !== currentVersion)
    .sort((a, b) => compareVersions(b, a))
  const destination = destinations[0]
  return destination
    ? {
        targetVersion: destination,
        path: paths.get(destination),
        next: allowed.get(paths.get(destination)[0]),
      }
    : null
}
