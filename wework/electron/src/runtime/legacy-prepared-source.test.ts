import {
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
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { currentCoreProfile, profileRevision } from './release-profile.js'
import { atomicReleaseWrite, ReleaseStore, type DesktopRelease } from './release-store.js'
import { ownsLegacyPreparedSource } from './legacy-prepared-source.js'
const parentProcess = vi.hoisted(() => ({ executable: vi.fn() }))
vi.mock('./release-parent-process.js', () => ({
  releaseParentExecutable: parentProcess.executable,
}))
import { recoverReleaseLayout } from './release-layout-recovery.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'legacy-prepared-source-')))
  roots.push(home)
  const desktop = join(home, '.wegent/workbench/wework/default')
  const store = new ReleaseStore(join(desktop, 'user-data/releases'))
  const id = 'installed-0.6.2-legacy-copy'
  const slot = store.slot(id)
  const parent =
    process.platform === 'darwin'
      ? join(home, 'installed/Contents/MacOS/WeWork')
      : join(home, 'installed/WeWork.exe')
  const resources =
    process.platform === 'darwin'
      ? join(home, 'installed/Contents/Resources')
      : join(home, 'installed/resources')
  await mkdir(dirname(parent), { recursive: true })
  await mkdir(join(resources, 'app.asar'), { recursive: true })
  await writeFile(parent, 'delivered source executable')
  await writeFile(join(resources, 'app.asar/package.json'), JSON.stringify({ version: '0.6.2' }))
  const host = join(slot, 'host/application')
  await cp(join(home, 'installed'), host, { recursive: true })
  const source: DesktopRelease = {
    schemaVersion: 1,
    id,
    version: '0.6.2',
    executable:
      process.platform === 'darwin'
        ? join(host, 'Contents/MacOS/WeWork')
        : join(host, 'WeWork.exe'),
    resources:
      process.platform === 'darwin' ? join(host, 'Contents/Resources') : join(host, 'resources'),
    runtimeRoot: join(slot, 'runtimes'),
    profileRoot: join(slot, 'profile'),
    dataSchema: 1,
    readableDataSchemas: [1],
  }
  const profile = currentCoreProfile(dirname(store.root))
  for (const path of [profile, source.profileRoot]) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), '{"private":true}')
  }
  await store.save(source)
  await atomicReleaseWrite(join(store.root, 'active'), source.id)
  await atomicReleaseWrite(
    join(slot, 'prepared.json'),
    JSON.stringify({ sourceRevision: await profileRevision(profile) })
  )
  parentProcess.executable.mockResolvedValue(parent)
  return { home, desktop, store, source, profile, parent }
}

test('bridges an exact prepared legacy copy without changing live data or release selection', async () => {
  const { home, desktop, store, source, profile, parent } = await fixture()
  expect(await ownsLegacyPreparedSource(store, source, profile, parent)).toBe(true)
  await writeFile(join(profile, 'live-data'), 'running source data')
  await recoverReleaseLayout(store, profile, 1, { HOME: home })
  expect(await realpath(join(desktop, 'releases'))).toBe(await realpath(store.root))
  expect((await store.active())?.id).toBe(source.id)
  expect(await store.activation()).toBeNull()
  expect(await readFile(join(profile, 'live-data'), 'utf8')).toBe('running source data')
})

test('copied-host ownership cannot cancel an activation with a different live profile', async () => {
  const { home, store, source, profile } = await fixture()
  const target = { ...source, id: 'pending-target', version: '0.6.4' }
  await store.save(target)
  await store.activate(target, 'snapshot')
  const activation = await store.activation()
  await expect(recoverReleaseLayout(store, profile, 1, { HOME: home })).rejects.toThrow(
    'source profile'
  )
  expect(await store.activation()).toEqual(activation)
})

test.each(['slots', 'slot', 'host'])(
  'rejects a %s directory alias that moves copied programs outside their owner',
  async entry => {
    const { home, store, source, profile, parent } = await fixture()
    const path =
      entry === 'slots'
        ? join(store.root, 'slots')
        : entry === 'slot'
          ? store.slot(source.id)
          : join(store.slot(source.id), 'host')
    const outside = join(home, `foreign-${entry}`)
    await rename(path, outside)
    await symlink(outside, path, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await ownsLegacyPreparedSource(store, source, profile, parent)).toBe(false)
  }
)

test.each(['executable', 'app.asar', 'revision', 'profile', 'host'])(
  'rejects a legacy copy with a foreign or changed %s',
  async changed => {
    const { home, store, source, profile, parent } = await fixture()
    let requestedProfile = profile
    if (changed === 'executable') await writeFile(source.executable, 'foreign executable')
    if (changed === 'app.asar')
      await writeFile(join(source.resources, 'app.asar/foreign.js'), 'foreign application')
    if (changed === 'revision') await writeFile(join(profile, 'package.json'), '{"changed":true}')
    if (changed === 'profile') {
      requestedProfile = join(home, 'foreign-profile')
      await mkdir(requestedProfile)
    }
    if (changed === 'host') source.executable = parent
    expect(await ownsLegacyPreparedSource(store, source, requestedProfile, parent)).toBe(false)
  }
)
