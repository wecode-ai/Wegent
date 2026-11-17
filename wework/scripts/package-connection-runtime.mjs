import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  copyConnectionPackage,
  prepareRemoteConnectionProfile,
} from '../dsh/connection-host/remote-profile.js'
import { assertPortableHarnessRuntime } from './lib/portable-runtime.mjs'
import { packagedHarnessRuntimeCatalog } from './lib/packaged-harness-runtime.mjs'

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

/** Build-time only: package the existing immutable runtime and its connection libraries. */
export async function packageConnectionRuntime({
  runtimeRoot,
  dshRoot,
  nodeExecutable,
  destination,
}) {
  runtimeRoot = resolve(runtimeRoot)
  dshRoot = resolve(dshRoot)
  destination = resolve(destination)
  for (const source of [runtimeRoot, dshRoot]) {
    const path = relative(source, destination)
    if (path === '' || (!isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== '..'))
      throw new Error('Connection delivery must be outside its source directories')
  }
  const packages = new Map()
  for (const entry of await readdir(dshRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const root = join(dshRoot, entry.name)
    let manifest
    try {
      manifest = await readJson(join(root, 'package.json'))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (packages.has(manifest.name)) throw new Error('Connection package identity is duplicated')
    packages.set(manifest.name, { root, manifest })
  }
  const selected = new Set([
    '@wegent/dsh-connection-host',
    '@wegent/dsh-executor-runtime',
    '@wegent/dsh-plugin-runtime',
    ...[...packages].filter(([, item]) => item.manifest.wework?.connections).map(([name]) => name),
  ])
  for (const name of selected) {
    const item = packages.get(name)
    if (!item) throw new Error(`Connection runtime library is missing: ${name}`)
    for (const dependency of Object.keys({
      ...item.manifest.dependencies,
      ...item.manifest.peerDependencies,
    }))
      if (packages.has(dependency)) selected.add(dependency)
  }
  await assertPortableHarnessRuntime(runtimeRoot)
  await mkdir(dirname(destination), { recursive: true })
  // Claim a fresh build directory. Never replace a delivery in use by a running service.
  await mkdir(destination)
  let probe
  try {
    await cp(runtimeRoot, join(destination, 'runtime'), { recursive: true, verbatimSymlinks: true })
    await assertPortableHarnessRuntime(join(destination, 'runtime'))
    const packageRoots = []
    for (const name of selected) {
      const item = packages.get(name)
      const root = join('packages', basename(item.root))
      await copyConnectionPackage(item.root, join(destination, root))
      packageRoots.push(root.split(sep).join('/'))
    }
    await mkdir(join(destination, 'node'))
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
    await cp(nodeExecutable, join(destination, 'node', nodeName))
    probe = await mkdtemp(join(tmpdir(), 'connection-delivery-check-'))
    await prepareRemoteConnectionProfile({
      dataRoot: probe,
      ownerId: 1,
      runtimeRoot: join(destination, 'runtime'),
      packageRoots: packageRoots.map(root => join(destination, root)),
    })
    const manifest = {
      schemaVersion: 1,
      nodeExecutable: `node/${nodeName}`,
      runtimeRoot: 'runtime',
      packageRoots,
    }
    await writeFile(
      join(destination, 'connection-runtime.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
    return manifest
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [materializedRoot, nodeExecutable, destination, ...extra] = process.argv.slice(2)
  if (!materializedRoot || !nodeExecutable || !destination || extra.length)
    throw new Error(
      'Expected the materialized runtime root, delivered Node executable and output directory'
    )
  const catalog = packagedHarnessRuntimeCatalog(
    await readJson(join(materializedRoot, 'runtimes.json'))
  )
  const core = catalog.runtimes.find(runtime => runtime.role === 'core')
  await packageConnectionRuntime({
    runtimeRoot: join(materializedRoot, core.sourceFingerprint),
    dshRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../dsh'),
    nodeExecutable,
    destination,
  })
}
