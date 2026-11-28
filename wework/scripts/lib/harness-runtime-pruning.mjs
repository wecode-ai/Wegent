import { readFile, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const TARGET_NATIVE_ARTIFACTS = {
  'linux-arm64': { nodePty: 'linux-arm64', reflink: null },
  'linux-x64': { nodePty: 'linux-x64', reflink: null },
  'macos-arm64': { nodePty: 'darwin-arm64', reflink: 'reflink-darwin-arm64' },
  'macos-x64': { nodePty: 'darwin-x64', reflink: 'reflink-darwin-x64' },
  'windows-arm64': { nodePty: 'win32-arm64', reflink: 'reflink-win32-arm64-msvc' },
  'windows-x64': { nodePty: 'win32-x64', reflink: 'reflink-win32-x64-msvc' },
}

const NON_RUNTIME_SUFFIXES = ['.d.cts', '.d.mts', '.d.ts', '.map']
const NON_RUNTIME_FILES = new Set(['.modules.yaml', '.pnpm-workspace-state-v1.json'])

export async function pruneHarnessRuntime(root, target) {
  const nativeArtifacts = TARGET_NATIVE_ARTIFACTS[target]
  if (!nativeArtifacts) throw new Error(`Unsupported Harness runtime prune target: ${target}`)
  const removed = { directories: 0, files: 0 }
  const prunedPaths = new Set()
  await visit(root, nativeArtifacts, removed, prunedPaths)
  await removeDanglingLinks(root, removed, prunedPaths, new Map())
  return removed
}

async function visit(directory, nativeArtifacts, removed, prunedPaths) {
  const directoryName = basename(directory)
  const parentName = basename(dirname(directory))
  if (parentName === 'node-pty' && directoryName === 'third_party') {
    await rm(directory, { recursive: true, force: true })
    prunedPaths.add(directory)
    removed.directories += 1
    return
  }
  if (parentName === 'node-pty' && directoryName === 'prebuilds') {
    await removeOtherDirectories(directory, nativeArtifacts.nodePty, removed, prunedPaths)
    return
  }
  if (directoryName === '@reflink') {
    await removeOtherDirectories(
      directory,
      nativeArtifacts.reflink,
      removed,
      prunedPaths,
      'reflink-'
    )
  }

  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries.map(async entry => {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(child, nativeArtifacts, removed, prunedPaths)
      } else if (
        entry.isFile() &&
        (NON_RUNTIME_FILES.has(entry.name) ||
          NON_RUNTIME_SUFFIXES.some(suffix => entry.name.endsWith(suffix)))
      ) {
        await rm(child, { force: true })
        prunedPaths.add(child)
        removed.files += 1
      }
    })
  )
}

async function removeOtherDirectories(directory, retained, removed, prunedPaths, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries
      .filter(
        entry =>
          entry.isDirectory() &&
          entry.name.startsWith(prefix) &&
          (retained === null || entry.name !== retained)
      )
      .map(async entry => {
        await rm(join(directory, entry.name), { recursive: true, force: true })
        prunedPaths.add(join(directory, entry.name))
        removed.directories += 1
      })
  )
}

async function removeDanglingLinks(directory, removed, prunedPaths, optionalPackages) {
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries.map(async entry => {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        await removeDanglingLinks(child, removed, prunedPaths, optionalPackages)
      } else if (entry.isSymbolicLink()) {
        try {
          await realpath(child)
        } catch (error) {
          if (
            error.code !== 'ENOENT' ||
            !(await isRemovableLink(child, prunedPaths, optionalPackages))
          ) {
            throw new Error(`Harness runtime contains a broken symlink: ${child}`, { cause: error })
          }
          await rm(child, { force: true })
          removed.files += 1
        }
      }
    })
  )
}

async function isRemovableLink(link, prunedPaths, optionalPackages) {
  let target = resolve(dirname(link), await readlink(link))
  while (dirname(target) !== target) {
    if (prunedPaths.has(target)) return true
    target = dirname(target)
  }
  const scope = basename(dirname(link))
  const scoped = scope.startsWith('@')
  const modules = scoped ? dirname(dirname(link)) : dirname(link)
  if (basename(modules) !== 'node_modules') return false
  if (!optionalPackages.has(modules)) optionalPackages.set(modules, readOptionalPackages(modules))
  const name = scoped ? `${scope}/${basename(link)}` : basename(link)
  return (await optionalPackages.get(modules)).has(name)
}

async function readOptionalPackages(modules) {
  const manifests = [join(dirname(modules), 'package.json')]
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const directory = join(modules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(directory, { withFileTypes: true })) {
        if (child.isDirectory()) manifests.push(join(directory, child.name, 'package.json'))
      }
    } else {
      manifests.push(join(directory, 'package.json'))
    }
  }
  const optional = new Set()
  const required = new Set()
  for (const manifest of manifests) {
    let definition
    try {
      definition = JSON.parse(await readFile(manifest, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const name of Object.keys(definition.optionalDependencies ?? {})) optional.add(name)
    for (const name of Object.keys(definition.dependencies ?? {})) {
      if (!Object.hasOwn(definition.optionalDependencies ?? {}, name)) required.add(name)
    }
  }
  return new Set([...optional].filter(name => !required.has(name)))
}
