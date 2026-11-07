import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  atomicReleaseWrite,
  optionalText,
  ReleaseStore,
  type DesktopRelease,
} from './release-store.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-release-test-'))
  roots.push(root)
  const store = new ReleaseStore(root)
  const release = (id: string, schema: number): DesktopRelease => ({
    schemaVersion: 1,
    id,
    version: `1.${schema}.0`,
    executable: join(root, id, 'host'),
    resources: join(root, id, 'resources'),
    runtimeRoot: join(root, id, 'runtimes'),
    profileRoot: join(root, id, 'profile'),
    dataSchema: schema,
    readableDataSchemas: [schema],
  })
  const before = release('before', 1)
  const after = release('after', 2)
  await mkdir(before.profileRoot, { recursive: true })
  await mkdir(after.profileRoot, { recursive: true })
  await writeFile(join(before.profileRoot, 'package.json'), '{}')
  await writeFile(join(after.profileRoot, 'package.json'), '{}')
  await store.save(before)
  await store.save(after)
  await atomicReleaseWrite(join(root, 'active'), before.id)
  return { store, before, after, root }
}

async function macosFixture() {
  const f = await fixture()
  const executable = join(f.root, 'Installed.app/Contents/MacOS/WeWork')
  const before = {
    ...f.before,
    profileRoot: join(f.store.slot(f.before.id), 'profile'),
    runtimeRoot: join(f.store.slot(f.before.id), 'runtimes'),
  }
  await mkdir(before.profileRoot, { recursive: true })
  await mkdir(before.runtimeRoot, { recursive: true })
  await writeFile(join(before.profileRoot, 'package.json'), '{"source":true}')
  await f.store.save(before)
  const retained: DesktopRelease = {
    ...before,
    id: 'macos-source-retained',
    executable,
    retainedRelease: before.id,
    macosInstallation: {
      payloadExecutable: join(
        f.store.slot('macos-source-retained'),
        'host/WeWork.app/Contents/MacOS/WeWork'
      ),
      bootstrapFromPayload: false,
    },
  }
  const after: DesktopRelease = {
    ...f.after,
    executable,
    macosInstallation: {
      payloadExecutable: join(f.store.slot(f.after.id), 'host/WeWork.app/Contents/MacOS/WeWork'),
      bootstrapFromPayload: true,
      sourceReleaseId: before.id,
      rollbackReleaseId: retained.id,
    },
  }
  await f.store.save(retained)
  await f.store.save(after)
  return { ...f, before, retained, after }
}

test('macOS keeps an immutable bootstrap while exposing the installed executable', async () => {
  const { store, root, after } = await macosFixture()
  expect(await readFile(join(store.slot(after.id), 'executable'), 'utf8')).toBe(
    after.macosInstallation!.payloadExecutable
  )
  expect(await readFile(join(store.slot(after.id), 'installed-executable'), 'utf8')).toBe(
    after.executable
  )
  await store.activate(after, 'snapshot')
  await store.confirm(after.id)
  expect(await optionalText(join(root, 'bridge'))).toBe(after.macosInstallation!.payloadExecutable)
})

test('macOS rollback keeps its physical restore intent after the activation journal closes', async () => {
  const { store, root, after, retained } = await macosFixture()
  await store.activate(after, 'snapshot')
  await store.confirm(after.id)
  await store.requestRollback()

  await store.rollback()

  expect(await store.activation()).toBeNull()
  expect((await store.active())?.id).toBe(retained.id)
  expect(await optionalText(join(root, 'macos-rollback'))).toBe(retained.id)
})

test('a healthy macOS activation clears a restore handoff left by an older source', async () => {
  const { store, root, after, retained } = await macosFixture()
  await atomicReleaseWrite(join(root, 'macos-rollback'), retained.id)
  await store.activate(after, 'snapshot')

  await store.confirm(after.id)

  expect(await optionalText(join(root, 'macos-rollback'))).toBeNull()
})

test('macOS activation binds the stopped source profile and retains its owner', async () => {
  const { store, before, after, retained } = await macosFixture()
  const stopped = { ...before, profileRoot: join(store.slot(before.id), 'retained-profile') }
  await store.save(stopped)
  await store.activate(after, 'real-snapshot')
  expect(await store.activation()).toMatchObject({
    from: retained.id,
    to: after.id,
    snapshot: 'real-snapshot',
  })
  expect((await store.read(retained.id)).profileRoot).toBe(stopped.profileRoot)
  expect((await store.read(before.id)).executable).toBe(before.executable)
  for (const id of [before.id, retained.id])
    expect(
      JSON.parse((await optionalText(join(store.slot(id), 'preserved-data-snapshot')))!)
    ).toEqual({ kind: 'macos-source-owner', owner: retained.id, snapshot: 'real-snapshot' })
})

test.each([false, true])(
  'a delivered activation can bind its source only before data opens (%s)',
  async opened => {
    const { store, before, after, retained, root } = await macosFixture()
    await store.save({ ...after, macosInstallation: undefined })
    await store.activate(after, 'snapshot')
    const original = (await store.activation())!
    await store.save(after)
    await atomicReleaseWrite(join(root, 'attempted'), original.token)
    if (opened) await atomicReleaseWrite(join(root, 'data-opened'), original.token)
    if (opened) {
      await expect(store.repairMacosActivationSource(after)).rejects.toThrow('after data opens')
      expect((await store.activation())!.from).toBe(before.id)
    } else {
      await store.repairMacosActivationSource(after)
      expect(await store.activation()).toEqual({ ...original, from: retained.id })
      expect(await optionalText(join(root, 'bridge'))).toBe(
        after.macosInstallation!.payloadExecutable
      )
      await store.repairMacosActivationSource(after)
      expect(await store.activation()).toEqual({ ...original, from: retained.id })
    }
  }
)

test('a loaded target bootstrap owns recovery even when a new installer already bound its source', async () => {
  const { store, after, retained, root } = await macosFixture()
  await store.activate(after, 'snapshot')
  expect(await optionalText(join(root, 'bridge'))).toBe(
    retained.macosInstallation!.payloadExecutable
  )
  expect(await optionalText(join(root, 'healthy'))).toBeNull()
  await store.repairMacosActivationSource(after)
  expect(await optionalText(join(root, 'bridge'))).toBe(after.macosInstallation!.payloadExecutable)
  expect(await optionalText(join(root, 'healthy'))).toBeNull()
  expect(await store.activation()).toMatchObject({ from: retained.id, to: after.id })
})

test('macOS refuses a retained source with a different version or owner', async () => {
  const { store, after, retained } = await macosFixture()
  await store.save({ ...retained, version: '9.0.0' })
  await expect(store.activate(after, 'snapshot')).rejects.toThrow('does not match')
  expect(await store.activation()).toBeNull()
  await store.save({ ...retained, retainedRelease: after.id })
  await expect(store.activate(after, 'snapshot')).rejects.toThrow('does not match')
  expect(await store.activation()).toBeNull()
})

test('source profile ownership survives rollback and expires only after its alias is unreferenced', async () => {
  const { store, before, after, retained, root } = await macosFixture()
  await store.activate(after, 'snapshot')
  await store.confirm(after.id)
  await store.requestRollback()
  await store.rollback()
  await store.prune()
  expect(await readFile(join(before.profileRoot, 'package.json'), 'utf8')).toBe('{"source":true}')
  expect(await store.read(retained.id)).toMatchObject({ retainedRelease: before.id })
  const current = {
    ...before,
    id: 'new-current',
    retainedRelease: undefined,
    profileRoot: join(store.slot('new-current'), 'profile'),
    runtimeRoot: join(store.slot('new-current'), 'runtimes'),
  }
  await mkdir(current.profileRoot, { recursive: true })
  await writeFile(join(current.profileRoot, 'package.json'), '{}')
  await store.save(current)
  await atomicReleaseWrite(join(root, 'active'), current.id)
  await atomicReleaseWrite(join(root, 'bridge'), current.executable)
  await store.prune()
  await expect(readFile(join(before.profileRoot, 'package.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await expect(store.read(retained.id)).rejects.toMatchObject({ code: 'ENOENT' })
})
test('activation retains its source until runtime and renderer confirmation', async () => {
  const { store, before, after, root } = await fixture()
  await store.activate(after, 'snapshot')
  expect(await store.activation()).toMatchObject({
    from: 'before',
    to: 'after',
    restoreRequired: true,
  })
  await store.confirm('before')
  expect(await store.activation()).not.toBeNull()
  await store.confirm('after')
  expect(await readFile(join(root, 'bridge'), 'utf8')).toBe(after.executable)
  expect(await store.activation()).toBeNull()
  expect(await readFile(join(root, 'previousHealthy'), 'utf8')).toBe('before')
  await store.requestRollback()
  expect((await store.rollback()).id).toBe('before')
  expect((await store.active())?.id).toBe('before')
  expect(await readFile(join(root, 'bridge'), 'utf8')).toBe(before.executable)
})
test('concurrent activation cannot overwrite the recovery journal', async () => {
  const { store, after } = await fixture()
  await store.activate(after, 'snapshot')
  await expect(store.activate(after, 'other')).rejects.toThrow('already in progress')
  expect((await store.activation())?.snapshot).toBe('snapshot')
})
test('separate controllers cannot concurrently replace the same activation journal', async () => {
  const { store, after, root } = await fixture()
  const other = new ReleaseStore(root)
  const results = await Promise.allSettled([
    store.activate(after, 'first'),
    other.activate(after, 'second'),
  ])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect((await store.activation())?.snapshot).toBe('first')
})
test('an interrupted manual rollback retains its intent despite an earlier healthy marker', async () => {
  const { store, after, root } = await fixture()
  await store.activate(after, 'snapshot')
  const token = (await store.activation())!.token
  await atomicReleaseWrite(join(root, 'attempted'), token)
  await store.confirm(after.id)
  await store.requestRollback()
  const reopened = new ReleaseStore(root)
  expect(await optionalText(join(root, 'healthy'))).toBe(token)
  expect(await reopened.activation()).toMatchObject({
    rollbackRequested: true,
    restoreRequired: true,
    from: 'before',
    to: 'after',
  })
  expect((await reopened.rollback()).id).toBe('before')
  await expect(readFile(join(root, 'previousHealthy'))).rejects.toMatchObject({ code: 'ENOENT' })
})
test('an interrupted pointer switch still has a usable source descriptor', async () => {
  const { store, after, root } = await fixture()
  await store.activate(after, 'snapshot')
  await writeFile(join(root, 'active'), 'before')
  expect((await store.rollback()).id).toBe('before')
  expect(await store.activation()).toBeNull()
})
test('rejects path traversal and corrupt release metadata', async () => {
  const { store, root } = await fixture()
  expect(() => store.slot('../outside')).toThrow('identifier')
  await writeFile(join(root, 'slots/before/release.json'), '{}')
  await expect(store.read('before')).rejects.toThrow('descriptor')
})
test('cleanup retains the active and previous healthy release', async () => {
  const { store, before, after, root } = await fixture()
  const unused = { ...before, id: 'abandoned' }
  await store.save(unused)
  await store.activate(after, 'snapshot')
  await store.confirm(after.id)
  await store.prune()
  expect((await store.read(before.id)).id).toBe(before.id)
  expect((await store.read(after.id)).id).toBe(after.id)
  await expect(readFile(join(root, 'slots/abandoned/release.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})
if (process.platform === 'win32') {
  test('cleanup ignores an installed recovery bridge on another Windows drive', async () => {
    const { store, before, after, root } = await fixture()
    const drive = win32.parse(root).root.toLowerCase().startsWith('c:') ? 'D:/' : 'C:/'
    const executable = win32.resolve(drive, 'Program Files', 'Wework', 'WeWork.exe')
    await store.save({ ...before, executable })
    await atomicReleaseWrite(join(root, 'bridge'), executable)
    await store.save({ ...after, id: 'abandoned' })
    await store.prune()
    expect((await store.active())!.executable).toBe(executable)
    expect(await optionalText(join(root, 'bridge'))).toBe(executable)
    await expect(store.read('abandoned')).rejects.toMatchObject({ code: 'ENOENT' })
  })
}
test('cleanup preserves newer plugin data after an incompatible rollback', async () => {
  const { store, after } = await fixture()
  const release = { ...after, profileRoot: join(store.slot(after.id), 'profile') }
  await store.save(release)
  await mkdir(release.profileRoot)
  const state = join(release.profileRoot, '.wework-core-plugins.json')
  await writeFile(state, '{"disabled":["new-user-plugin"]}')
  await store.activate(release, 'snapshot')
  await atomicReleaseWrite(join(store.root, 'data-opened'), (await store.activation())!.token)
  await store.confirm(release.id)
  await store.requestRollback()
  await store.rollback()
  await store.prune()
  expect(await readFile(state, 'utf8')).toContain('new-user-plugin')
  expect(await readFile(join(store.root, 'preserved-data/snapshot/retained-release'), 'utf8')).toBe(
    release.id
  )
})
