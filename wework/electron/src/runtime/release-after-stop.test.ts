import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test, vi } from 'vitest'
import { assertReleaseAfterStopReady, prepareReleaseAfterStop } from './release-after-stop.js'
import { atomicReleaseWrite, ReleaseStore, type DesktopRelease } from './release-store.js'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const { testNodeEnvironment } = await import('./test-helpers.js')
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: (
      command: string,
      args: string[],
      options: import('node:child_process').ExecFileOptions
    ) => {
      expect(options.timeout).toBe(0)
      expect(options.env?.OPENAI_API_KEY).toBeUndefined()
      return promisify(original.execFile)(process.execPath, [command, ...args], {
        ...options,
        env: testNodeEnvironment(options.env),
      })
    },
  })
  return { ...original, execFile }
})

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(protocol: number | false = 1) {
  const root = await mkdtemp(join(tmpdir(), 'wework stopped preparation '))
  roots.push(root)
  const store = new ReleaseStore(join(root, 'releases'))
  const source: DesktopRelease = {
    schemaVersion: 1,
    id: 'source',
    version: '1.0.0',
    executable: join(root, 'source'),
    resources: join(root, 'source-resources'),
    runtimeRoot: join(root, 'runtimes'),
    profileRoot: join(root, 'profile'),
    dataSchema: 1,
    readableDataSchemas: [1],
  }
  await store.save(source)
  await atomicReleaseWrite(join(store.root, 'active'), source.id)
  const target: DesktopRelease = {
    ...source,
    id: 'target',
    version: '1.1.0',
    executable: join(root, 'target.cjs'),
    resources: join(root, 'target-resources'),
    packageSha256: 'a'.repeat(64),
  }
  await mkdir(join(target.resources, 'app.asar'), { recursive: true })
  await writeFile(
    join(target.resources, 'app.asar', 'package.json'),
    JSON.stringify(protocol === false ? {} : { weworkAfterStopPreparation: protocol })
  )
  await store.save(target)
  await store.activate(target, 'snapshot')
  const homes = { codexHome: join(root, 'codex'), workbenchRoot: join(root, 'workbench') }
  const valid = `const fs=require('node:fs');const request=JSON.parse(fs.readFileSync(process.argv.at(-1),'utf8'));if(fs.readFileSync(require('node:path').join(request.storeRoot,'data-opened'),'utf8')!==request.token)process.exit(2);process.stdout.write(JSON.stringify({protocol:1,releaseId:request.release.id,token:request.token,complete:true}));`
  await writeFile(target.executable, valid)
  return { root, store, source, target, homes, valid }
}

test('stopped preparation precedes the timed trial and admits only its matching package', async () => {
  const { root, store, target, homes } = await fixture()
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-not-forwarded')
  await expect(
    assertReleaseAfterStopReady(store, target, { weworkAfterStopPreparation: 1 })
  ).rejects.toThrow('bridge updater')
  await prepareReleaseAfterStop(store, target, root, homes)
  await expect(
    assertReleaseAfterStopReady(store, target, { weworkAfterStopPreparation: 1 })
  ).resolves.toBeUndefined()
  for (const marker of ['attempted', 'healthy'])
    await expect(readFile(join(store.root, marker))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(
    assertReleaseAfterStopReady(
      store,
      { ...target, packageSha256: 'b'.repeat(64) },
      { weworkAfterStopPreparation: 1 }
    )
  ).rejects.toThrow('bridge updater')
})

test('a stopped hook can restart after failure without confirming or replacing its activation', async () => {
  const { root, store, target, homes, valid } = await fixture()
  const activation = await store.activation()
  await writeFile(
    target.executable,
    "process.stderr.write('synthetic-private-history');process.exit(4)"
  )
  await expect(prepareReleaseAfterStop(store, target, root, homes)).rejects.toThrow(
    'healthy release will recover'
  )
  expect(await store.activation()).toEqual(activation)
  await expect(readFile(join(store.root, 'after-stop-ready.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await writeFile(target.executable, valid)
  await prepareReleaseAfterStop(store, target, root, homes)
  await expect(
    assertReleaseAfterStopReady(store, target, { weworkAfterStopPreparation: 1 })
  ).resolves.toBeUndefined()
})

test.each([2, 0])(
  'rejects unknown preparation protocol %s before starting the target',
  async protocol => {
    const { root, store, target, homes } = await fixture(protocol)
    await expect(prepareReleaseAfterStop(store, target, root, homes)).rejects.toThrow('Unsupported')
    await expect(readFile(join(store.root, 'data-opened'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  }
)

test('legacy targets and manual rollback do not run a migration hook', async () => {
  const { root, store, target, homes } = await fixture(false)
  await rm(target.executable)
  await prepareReleaseAfterStop(store, target, root, homes)
  await expect(readFile(join(store.root, 'after-stop-ready.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await writeFile(
    join(target.resources, 'app.asar', 'package.json'),
    JSON.stringify({ weworkAfterStopPreparation: 1 })
  )
  const activation = (await store.activation())!
  await atomicReleaseWrite(
    join(store.root, 'activation.json'),
    JSON.stringify({ ...activation, rollbackRequested: true })
  )
  await prepareReleaseAfterStop(store, target, root, homes)
})

test('unacknowledged output cannot admit a trial or leak child diagnostics', async () => {
  const { root, store, target, homes } = await fixture()
  await writeFile(target.executable, "process.stdout.write('synthetic-private-history')")
  await expect(prepareReleaseAfterStop(store, target, root, homes)).rejects.not.toThrow(
    'synthetic-private-history'
  )
  await expect(
    assertReleaseAfterStopReady(store, target, { weworkAfterStopPreparation: 1 })
  ).rejects.toThrow('bridge updater')
})
