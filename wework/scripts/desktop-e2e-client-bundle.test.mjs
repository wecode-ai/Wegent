import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, test } from 'vitest'

const run = promisify(execFile)
const wework = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { compressToUTF16 } = require('lz-string')
const inventory = { entries: { account: { deviceId: 'test-device', installedPlugins: [] } } }
const compressed = `lz:${compressToUTF16(JSON.stringify(inventory))}`
let root
let bundle

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wework-client-bundle-'))
  bundle = join(root, 'shared-build', 'e2e-client')
  await run(process.execPath, [join(wework, 'scripts/build-desktop-e2e-client.mjs'), bundle], {
    cwd: wework,
  })
}, 30_000)

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

async function isolatedConsumer(name) {
  const consumer = join(root, name)
  const desktop = join(consumer, 'wework/e2e/desktop')
  await cp(join(wework, 'e2e/desktop'), desktop, { recursive: true })
  const client = join(consumer, '.ci-artifacts/e2e-client')
  await cp(bundle, client, { recursive: true })
  return {
    consumer,
    desktop,
    client,
    options: {
      cwd: consumer,
      env: {
        ...process.env,
        NODE_PATH: '',
        WEWORK_E2E_SOCKET_IO_CLIENT: join(client, 'socket.io-client.cjs'),
      },
    },
  }
}

test('the shared build loads plugin scenarios and decodes inventory without node_modules', async () => {
  const fixture = await isolatedConsumer('clean')
  await assert.rejects(access(join(fixture.consumer, 'node_modules')))
  await assert.rejects(access(join(fixture.consumer, 'wework/node_modules')))
  const script = `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    import { pathToFileURL } from 'node:url'
    assert.throws(() => createRequire(pathToFileURL(process.argv[2])).resolve('lz-string'), { code: 'MODULE_NOT_FOUND' })
    const scene = await import(pathToFileURL(process.argv[1]))
    assert.equal(typeof scene.createDesktopScenario, 'function')
    const { decodeInventory } = await import(pathToFileURL(process.argv[2]))
    assert.deepEqual(decodeInventory(process.argv[3]), JSON.parse(process.argv[4]))
    assert.equal(typeof createRequire(import.meta.url)(process.env.WEWORK_E2E_SOCKET_IO_CLIENT).io, 'function')
  `
  await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      join(fixture.desktop, 'scenarios/plugin-uninstall-resilience.scenario.mjs'),
      join(fixture.desktop, 'modules/plugin-scope-boundaries.mjs'),
      compressed,
      JSON.stringify(Object.values(inventory.entries)),
    ],
    fixture.options
  )
}, 30_000)

test('an explicitly configured incomplete artifact never falls back to workspace dependencies', async () => {
  const fixture = await isolatedConsumer('incomplete')
  await rm(join(fixture.client, 'lz-string.cjs'))
  const nodeModules = join(fixture.consumer, 'wework/node_modules')
  await mkdir(nodeModules, { recursive: true })
  await symlink(
    dirname(require.resolve('lz-string/package.json')),
    join(nodeModules, 'lz-string'),
    'junction'
  )
  await assert.rejects(
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { pathToFileURL } from 'node:url'; await import(pathToFileURL(process.argv[1]))",
        join(fixture.desktop, 'modules/plugin-scope-boundaries.mjs'),
      ],
      fixture.options
    ),
    error => error.stderr.includes('MODULE_NOT_FOUND') && error.stderr.includes('lz-string.cjs')
  )
}, 30_000)
