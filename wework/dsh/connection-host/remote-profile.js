import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const PROFILE = 'wework-connections'
const HOST = '@wegent/dsh-connection-host'
const LIBRARIES = [HOST, '@wegent/dsh-plugin-runtime', '@wegent/dsh-executor-runtime']
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

function outside(root, target) {
  const location = relative(root, target)
  return location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)
}

export async function copyConnectionPackage(root, destination) {
  await mkdir(dirname(destination), { recursive: true })
  const source = await realpath(root)
  await cp(root, destination, {
    recursive: true,
    // Validate every target below, then materialize links so moved deliveries
    // cannot retain either relative or absolute references to a build tree.
    dereference: true,
    filter: async path => {
      if (
        relative(root, path).split(/[\\/]/).includes('node_modules') ||
        path.endsWith('.test.mjs')
      )
        return false
      if (outside(source, await realpath(path)))
        throw new Error('Connection package link escapes its delivered code root')
      return true
    },
  })
}

async function previousPackages(path, ownerId) {
  let previous
  try {
    previous = await readJson(path)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  if (
    previous.schemaVersion !== 1 ||
    previous.ownerId !== ownerId ||
    !/^[a-f0-9]{64}$/.test(previous.sourceFingerprint) ||
    !Array.isArray(previous.packages) ||
    !previous.packages.every(name => typeof name === 'string' && PACKAGE.test(name))
  )
    throw new Error('Connection runtime profile metadata is invalid')
  return previous.packages
}

/** Prepare code and a dedicated owner home; never install floating dependencies. */
export async function prepareRemoteConnectionProfile({
  dataRoot,
  runtimeRoot,
  packageRoots,
  ownerId,
}) {
  if (
    !Number.isSafeInteger(ownerId) ||
    ownerId <= 0 ||
    !isAbsolute(dataRoot) ||
    !isAbsolute(runtimeRoot)
  )
    throw new Error('Connection runtime requires an explicit owner and absolute roots')
  const runtime = await readJson(join(runtimeRoot, 'runtime.json'))
  const dshRoot = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const dsh = await readJson(join(dshRoot, 'package.json'))
  if (dsh.version !== runtime.dshVersion || !/^[a-f0-9]{64}$/.test(runtime.sourceFingerprint))
    throw new Error('Connection runtime does not match the delivered DSH package')
  const entry = await realpath(join(dshRoot, 'lib', 'bin.js'))
  const request = createRequire(entry)
  const { satisfies } = request('semver')
  const packages = new Map()
  for (const root of packageRoots) {
    if (!isAbsolute(root)) throw new Error('Connection package root must be absolute')
    const manifest = await readJson(join(root, 'package.json'))
    if (!PACKAGE.test(manifest.name ?? '') || packages.has(manifest.name))
      throw new Error('Connection package identity is invalid or duplicated')
    packages.set(manifest.name, { root, manifest })
  }
  if (LIBRARIES.some(name => !packages.has(name)))
    throw new Error('Connection runtime libraries are incomplete')
  const ownerHome = join(dataRoot, 'accounts', String(ownerId))
  const dshHome = join(ownerHome, 'dsh')
  const profileRoot = join(dshHome, 'profiles', PROFILE)
  for (const root of [runtimeRoot, ...packageRoots]) {
    if (!outside(resolve(root), profileRoot))
      throw new Error('Connection runtime data must be outside its immutable code roots')
  }
  const external = new Map()
  const requirePackage = async (name, range) => {
    const local = packages.get(name)
    const path = local ? join(local.root, 'package.json') : request.resolve(`${name}/package.json`)
    const manifest = local?.manifest ?? (await readJson(path))
    if (!satisfies(manifest.version, range, { includePrerelease: true }))
      throw new Error(`Delivered connection dependency does not satisfy ${name}`)
    if (!local) external.set(name, dirname(path))
  }
  await requirePackage('@deepseek-ai/dsh-host-webserver', runtime.dshVersion)
  for (const { manifest } of packages.values())
    for (const [name, range] of Object.entries({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    }))
      await requirePackage(name, range)
  const bundles = [
    HOST,
    ...[...packages.values()]
      .filter(({ manifest }) => manifest.wework?.connections)
      .map(({ manifest }) => manifest.name),
  ]
  for (const name of bundles) {
    const { root, manifest } = packages.get(name)
    const patch = manifest.dsh?.bundle?.patch
    if (typeof patch !== 'string' || isAbsolute(patch) || outside(root, resolve(root, patch)))
      throw new Error('Connection plugin bundle patch escapes its package')
    const target = await realpath(resolve(root, patch))
    if (outside(await realpath(root), target))
      throw new Error('Connection plugin bundle patch escapes its package')
    await readFile(target)
  }
  await mkdir(profileRoot, { recursive: true, mode: 0o700 })
  const stamp = join(profileRoot, '.connection-service.json')
  const previous = await previousPackages(stamp, ownerId)
  const managed = [...packages.keys(), ...external.keys()]
  for (const name of new Set([...previous, ...managed]))
    await rm(join(profileRoot, 'node_modules', ...name.split('/')), {
      recursive: true,
      force: true,
    })
  for (const [name, { root }] of packages) {
    const destination = join(profileRoot, 'node_modules', ...name.split('/'))
    await copyConnectionPackage(root, destination)
  }
  for (const [name, root] of external) {
    const destination = join(profileRoot, 'node_modules', ...name.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await symlink(root, destination, process.platform === 'win32' ? 'junction' : 'dir')
  }
  await writeFile(
    join(profileRoot, 'package.json'),
    JSON.stringify({
      name: `dsh-profile-${PROFILE}`,
      private: true,
      dependencies: Object.fromEntries([
        ...[...packages].map(([name, { root }]) => [name, `file:${root}`]),
        ...[...external].map(([name, root]) => [name, `file:${root}`]),
      ]),
      dsh: { profile: { bundles } },
    }),
    { mode: 0o600 }
  )
  await writeFile(join(profileRoot, 'cordis.yml'), '[]\n', { mode: 0o600 })
  await writeFile(
    join(profileRoot, 'cordis.patch.yml'),
    "- insert:\n    - id: connection-web-server\n      name: '@deepseek-ai/dsh-host-webserver'\n      config:\n        host: 127.0.0.1\n        port: 0\n",
    { mode: 0o600 }
  )
  await writeFile(
    stamp,
    JSON.stringify({
      schemaVersion: 1,
      ownerId,
      packages: managed,
      sourceFingerprint: runtime.sourceFingerprint,
    }),
    { mode: 0o600 }
  )
  return {
    entry,
    profileRoot,
    args: [entry, '--profile', PROFILE],
    environment: {
      HOME: ownerHome,
      USERPROFILE: ownerHome,
      DSH_HOME: dshHome,
      WEWORK_CONNECTION_OWNER_ID: String(ownerId),
      DSH_TELEMETRY_DISABLED: '1',
    },
  }
}
