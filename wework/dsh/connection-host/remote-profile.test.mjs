import assert from 'node:assert/strict'
import test from 'node:test'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareRemoteConnectionProfile } from './remote-profile.js'
import { readConnectionRuntimeDelivery } from './remote-delivery.js'
import { packageConnectionRuntime } from '../../scripts/package-connection-runtime.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

async function fixture(root) {
  const runtimeRoot = join(root, 'runtime')
  const packageFile = async (name, manifest, modules) => {
    const path = join(modules, ...name.split('/'))
    await mkdir(join(path, 'lib'), { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, ...manifest }))
    await writeFile(join(path, 'lib', 'bin.js'), '// Metadata fixture; never executed.\n')
    await writeFile(join(path, 'cordis.patch.yml'), '[]\n')
    return path
  }
  await packageFile(
    '@deepseek-ai/dsh',
    { version: '0.2.0-rc.2' },
    join(runtimeRoot, 'node_modules')
  )
  await packageFile(
    '@deepseek-ai/dsh-host-webserver',
    { version: '0.2.0-rc.2' },
    join(runtimeRoot, 'node_modules')
  )
  await writeFile(
    join(runtimeRoot, 'runtime.json'),
    JSON.stringify({ dshVersion: '0.2.0-rc.2', sourceFingerprint: 'a'.repeat(64) })
  )
  await symlink(
    dirname(createRequire(import.meta.url).resolve('semver/package.json')),
    join(runtimeRoot, 'node_modules', 'semver'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const modules = join(root, 'delivered', 'node_modules')
  const packageRoots = []
  for (const name of [
    '@wegent/dsh-connection-host',
    '@wegent/dsh-plugin-runtime',
    '@wegent/dsh-executor-runtime',
    '@test/documents',
  ]) {
    const manifest = { version: '0.1.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }
    if (name === '@test/documents') manifest.wework = { connections: { apiVersion: 1 } }
    packageRoots.push(await packageFile(name, manifest, modules))
  }
  return { dataRoot: join(root, 'data'), runtimeRoot, packageRoots, ownerId: 7 }
}

test('remote profiles use only delivered code, isolate owners and preserve state through restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-connection-profile-'))
  try {
    const options = await fixture(root)
    const first = await prepareRemoteConnectionProfile(options)
    const manifest = JSON.parse(await readFile(join(first.profileRoot, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@wegent/dsh-connection-host',
      '@test/documents',
    ])
    assert.ok(Object.values(manifest.dependencies).every(value => value.startsWith('file:')))
    await access(
      join(first.profileRoot, 'node_modules', '@wegent', 'dsh-connection-host', 'package.json')
    )
    const state = join(first.profileRoot, 'provider-state.json')
    await writeFile(state, JSON.stringify({ cursor: 41 }))
    const restarted = await prepareRemoteConnectionProfile(options)
    assert.equal(restarted.profileRoot, first.profileRoot)
    assert.equal(await readFile(state, 'utf8'), '{"cursor":41}')
    const other = await prepareRemoteConnectionProfile({ ...options, ownerId: 8 })
    assert.notEqual(other.environment.DSH_HOME, first.environment.DSH_HOME)
    assert.equal(first.environment.WEWORK_CONNECTION_OWNER_ID, '7')
    assert.equal(other.environment.WEWORK_CONNECTION_OWNER_ID, '8')
    assert.equal(first.environment.WEGENT_AUTH_TOKEN, undefined)
    assert.equal(first.environment.OPENAI_API_KEY, undefined)
    await assert.rejects(access(join(other.profileRoot, 'provider-state.json')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('corrupt owner metadata cannot reset or reuse an existing profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-connection-profile-'))
  try {
    const options = await fixture(root)
    const prepared = await prepareRemoteConnectionProfile(options)
    const state = join(prepared.profileRoot, 'provider-state.json')
    await writeFile(state, '{"cursor":41}')
    const stamp = join(prepared.profileRoot, '.connection-service.json')
    const metadata = JSON.parse(await readFile(stamp, 'utf8'))
    await writeFile(stamp, JSON.stringify({ ...metadata, ownerId: 8 }))
    await assert.rejects(prepareRemoteConnectionProfile(options), /profile metadata is invalid/)
    assert.equal(await readFile(state, 'utf8'), '{"cursor":41}')
    assert.equal(JSON.parse(await readFile(stamp, 'utf8')).ownerId, 8)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the service launcher removes inherited model and service credentials before loading DSH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-connection-profile-'))
  try {
    const options = await fixture(root)
    const entry = join(options.runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await writeFile(
      entry,
      'exports.runCli = async () => console.log(JSON.stringify({hasService:!!process.env.BACKEND_INTERNAL_TOKEN,hasModel:!!process.env.OPENAI_API_KEY,hasAccount:!!process.env.WEGENT_AUTH_TOKEN,owner:process.env.WEWORK_CONNECTION_OWNER_ID,home:process.env.HOME,cwd:process.cwd(),endpoint:process.env.WEWORK_EXECUTOR_ENDPOINT}))\n'
    )
    const manifest = join(root, 'connection-runtime.json')
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        nodeExecutable: process.execPath,
        runtimeRoot: options.runtimeRoot,
        packageRoots: options.packageRoots,
      })
    )
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { runRemoteConnectionService } from ${JSON.stringify(new URL('./remote-service-runtime.js', import.meta.url).href)}; await runRemoteConnectionService(${JSON.stringify([manifest, options.dataRoot, '7'])}, async () => () => {});`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMPDIR: process.env.TMPDIR,
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          BACKEND_INTERNAL_TOKEN: 'synthetic-service',
          OPENAI_API_KEY: 'synthetic-model',
          WEGENT_AUTH_TOKEN: 'synthetic-account',
          WEWORK_EXECUTOR_ENDPOINT: 'synthetic-reader-endpoint',
          WEWORK_EXECUTOR_TOKEN: 'synthetic-reader-token',
        },
      }
    )
    const observed = JSON.parse(result.stdout)
    assert.equal(observed.hasService, false)
    assert.equal(observed.hasModel, false)
    assert.equal(observed.hasAccount, false)
    assert.equal(observed.owner, '7')
    assert.equal(observed.home, join(options.dataRoot, 'accounts', '7'))
    assert.equal(await realpath(observed.cwd), await realpath(observed.home))
    assert.equal(observed.endpoint, 'synthetic-reader-endpoint')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a connection bundle cannot reference code outside its delivered package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-connection-profile-'))
  try {
    const options = await fixture(root)
    const provider = options.packageRoots.at(-1)
    const manifest = JSON.parse(await readFile(join(provider, 'package.json'), 'utf8'))
    manifest.dsh.bundle.patch = '../outside.patch.yml'
    await writeFile(join(provider, 'package.json'), JSON.stringify(manifest))
    await assert.rejects(prepareRemoteConnectionProfile(options), /patch escapes its package/)
    const unrelated = join(root, 'unrelated')
    await mkdir(unrelated)
    await writeFile(join(unrelated, 'outside.patch.yml'), '[]\n')
    await symlink(
      unrelated,
      join(provider, 'external'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    manifest.dsh.bundle.patch = './external/outside.patch.yml'
    await writeFile(join(provider, 'package.json'), JSON.stringify(manifest))
    await assert.rejects(prepareRemoteConnectionProfile(options), /patch escapes its package/)
    await assert.rejects(access(join(options.dataRoot, 'accounts', '7', 'dsh')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a delivered connection runtime survives relocation and cannot overwrite a running delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-connection-delivery-'))
  try {
    const options = await fixture(root)
    const semver = join(options.runtimeRoot, 'node_modules', 'semver')
    const semverSource = await realpath(semver)
    await rm(semver)
    await cp(semverSource, semver, { recursive: true })
    const provider = options.packageRoots.at(-1)
    await mkdir(join(provider, 'helpers'))
    await writeFile(join(provider, 'helpers', 'read.js'), 'export const portable = true\n')
    const dshRoot = join(root, 'dsh')
    for (const [index, source] of options.packageRoots.entries())
      await cp(source, join(dshRoot, `package-${index}`), { recursive: true })
    const deliveredProvider = join(dshRoot, `package-${options.packageRoots.length - 1}`)
    await symlink(
      'helpers',
      join(deliveredProvider, 'relative-helpers'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await symlink(
      join(deliveredProvider, 'helpers'),
      join(deliveredProvider, 'absolute-helpers'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const destination = join(root, 'delivery')
    const input = {
      runtimeRoot: options.runtimeRoot,
      dshRoot,
      nodeExecutable: process.execPath,
      destination,
    }
    const manifest = await packageConnectionRuntime(input)
    assert.equal(manifest.runtimeRoot, 'runtime')
    assert.ok(manifest.packageRoots.every(path => path.startsWith('packages/')))
    await assert.rejects(packageConnectionRuntime(input), error => error.code === 'EEXIST')
    const moved = join(root, 'another-device', 'connection-runtime')
    await mkdir(dirname(moved), { recursive: true })
    await rename(destination, moved)
    await rm(dshRoot, { recursive: true, force: true })
    await rm(options.runtimeRoot, { recursive: true, force: true })
    await rm(join(root, 'delivered'), { recursive: true, force: true })
    const delivered = await readConnectionRuntimeDelivery(join(moved, 'connection-runtime.json'))
    assert.equal(delivered.runtimeRoot, join(moved, 'runtime'))
    await access(delivered.nodeExecutable)
    const profile = await prepareRemoteConnectionProfile({
      ...delivered,
      dataRoot: options.dataRoot,
      ownerId: 7,
    })
    assert.ok(profile.entry.startsWith(await realpath(moved)))
    const profileManifest = JSON.parse(
      await readFile(join(profile.profileRoot, 'package.json'), 'utf8')
    )
    assert.ok(Object.values(profileManifest.dependencies).every(path => path.includes(moved)))
    for (const directory of ['relative-helpers', 'absolute-helpers'])
      assert.equal(
        await readFile(
          join(profile.profileRoot, 'node_modules', '@test', 'documents', directory, 'read.js'),
          'utf8'
        ),
        'export const portable = true\n'
      )
    const persisted = await readFile(join(moved, 'connection-runtime.json'), 'utf8')
    assert.equal(persisted.includes(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delivery metadata rejects parent traversal before resolving plugin paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-connection-delivery-'))
  try {
    const path = join(root, 'connection-runtime.json')
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        runtimeRoot: 'runtime',
        nodeExecutable: 'node/node',
        packageRoots: ['../outside'],
      })
    )
    await assert.rejects(
      readConnectionRuntimeDelivery(path),
      /delivery.*path is invalid|service path is invalid/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
