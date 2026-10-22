import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const CORDIS_PACKAGE = '@deepseek-ai/cordis'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CLIENT_RENDERER_PACKAGE = '@deepseek-ai/dsh-client-ui-renderer'
const CLIENT_RUNTIME_PACKAGE = '@deepseek-ai/dsh-client-runtime'

/**
 * Validate packaged web plugin manifests against the selected DSH runtime.
 */
export async function validateDshWebPluginManifests({
  coreRuntimeSourcePath,
  harnessRuntimeRoot,
  pluginRoots,
}) {
  const dshVersion = await readCoreDshVersion(coreRuntimeSourcePath)
  const compatibility = await readRuntimeCompatibility(harnessRuntimeRoot, dshVersion)

  for (const pluginRoot of pluginRoots) {
    const manifest = await readManifest(pluginRoot)
    if (manifest.dsh?.client?.platform !== 'web') continue
    validateWebPluginManifest(manifest, compatibility)
  }
}

/** Read the DSH version selected by the Electron runtime. */
async function readCoreDshVersion(sourcePath) {
  const source = await readFile(sourcePath, 'utf8')
  const match = source.match(/export const CORE_DSH_VERSION = (['"])([^'"]+)\1/)
  if (!match) throw new Error(`CORE_DSH_VERSION is missing from ${sourcePath}`)
  return match[2]
}

/** Derive renderer and Cordis requirements from the selected runtime lockfile. */
async function readRuntimeCompatibility(harnessRuntimeRoot, dshVersion) {
  const lockfilePath = join(harnessRuntimeRoot, 'runtimes', dshVersion, 'pnpm-lock.yaml')
  const lockfile = await readFile(lockfilePath, 'utf8')
  const selectedVersion = readSelectedDshVersion(lockfile, lockfilePath)
  if (selectedVersion !== dshVersion) {
    throw new Error(
      `${lockfilePath} selects ${DSH_PACKAGE}@${selectedVersion}, expected ${dshVersion}`
    )
  }

  const renderer = readSinglePackageEntry(lockfile, CLIENT_RENDERER_PACKAGE, lockfilePath)
  return {
    cordisVersion: readPeerDependency(renderer.lines, CORDIS_PACKAGE, renderer.label),
    rendererVersion: renderer.version,
  }
}

/** Read the root importer's selected DSH specifier. */
function readSelectedDshVersion(lockfile, lockfilePath) {
  const escapedPackage = escapeRegExp(DSH_PACKAGE)
  const match = lockfile.match(
    new RegExp(`^ {6}'${escapedPackage}':\\r?\\n {8}specifier: ([^\\r\\n]+)$`, 'm')
  )
  if (!match) throw new Error(`${lockfilePath} does not select ${DSH_PACKAGE}`)
  return parseYamlScalar(match[1])
}

/** Find one exact package entry in the lockfile packages section. */
function readSinglePackageEntry(lockfile, packageName, lockfilePath) {
  const lines = lockfile.split(/\r?\n/)
  const packagesStart = lines.indexOf('packages:')
  const snapshotsStart = lines.indexOf('snapshots:')
  if (packagesStart < 0 || snapshotsStart < 0 || snapshotsStart <= packagesStart) {
    throw new Error(`${lockfilePath} has no complete packages section`)
  }

  const headerPrefix = `  '${packageName}@`
  const matches = []
  for (let index = packagesStart + 1; index < snapshotsStart; index += 1) {
    const line = lines[index]
    if (!line.startsWith(headerPrefix) || !line.endsWith("':")) continue
    matches.push(index)
  }
  if (matches.length !== 1) {
    throw new Error(
      `${lockfilePath} must contain exactly one ${packageName} package entry; found ${matches.length}`
    )
  }

  const start = matches[0]
  let end = start + 1
  while (end < snapshotsStart && !/^  \S/.test(lines[end])) end += 1
  const version = lines[start].slice(headerPrefix.length, -2)
  return {
    label: `${packageName}@${version} in ${lockfilePath}`,
    lines: lines.slice(start + 1, end),
    version,
  }
}

/** Read a peer dependency from a lockfile package entry. */
function readPeerDependency(lines, packageName, entryLabel) {
  const peerDependenciesStart = lines.indexOf('    peerDependencies:')
  if (peerDependenciesStart < 0) {
    throw new Error(`${entryLabel} has no peerDependencies`)
  }

  const prefix = `      '${packageName}': `
  for (let index = peerDependenciesStart + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^    \S/.test(line)) break
    if (line.startsWith(prefix)) return parseYamlScalar(line.slice(prefix.length))
  }
  throw new Error(`${entryLabel} has no ${packageName} peer dependency`)
}

/** Validate one packaged web plugin manifest. */
function validateWebPluginManifest(manifest, compatibility) {
  const label = manifest.name || '<unnamed web plugin>'
  const inject = manifest.dsh?.client?.inject || []
  assertIncludes(inject, CLIENT_RENDERER_PACKAGE, `${label} dsh.client.inject`)
  assertExcludes(inject, CLIENT_RUNTIME_PACKAGE, `${label} dsh.client.inject`)
  assertEquals(
    manifest.peerDependencies?.[CORDIS_PACKAGE],
    compatibility.cordisVersion,
    `${label} peerDependencies.${CORDIS_PACKAGE}`
  )
  assertEquals(
    manifest.peerDependencies?.[CLIENT_RENDERER_PACKAGE],
    compatibility.rendererVersion,
    `${label} peerDependencies.${CLIENT_RENDERER_PACKAGE}`
  )
  assertEquals(
    manifest.peerDependencies?.[CLIENT_RUNTIME_PACKAGE],
    undefined,
    `${label} peerDependencies.${CLIENT_RUNTIME_PACKAGE}`
  )
}

/** Read one declared plugin manifest. Missing manifests are contract failures. */
async function readManifest(pluginRoot) {
  return JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
}

/** Require a dependency or injection list to contain one value. */
function assertIncludes(values, expected, label) {
  if (!values.includes(expected)) {
    throw new Error(`${label} must include ${expected}`)
  }
}

/** Require a dependency or injection list to omit one value. */
function assertExcludes(values, unexpected, label) {
  if (values.includes(unexpected)) {
    throw new Error(`${label} must not include ${unexpected}`)
  }
}

/** Require a manifest value to match the runtime-derived expectation. */
function assertEquals(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} must be ${String(expected)}, received ${String(actual)}`)
  }
}

/** Remove optional quotes from a scalar lockfile value. */
function parseYamlScalar(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Escape a package name before embedding it in a regular expression. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
