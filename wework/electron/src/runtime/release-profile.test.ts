import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  cloneReleaseProfile,
  currentCoreProfile,
  profileRevision,
  retainReleaseProfile,
  selectReleaseProfile,
} from './release-profile.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test.each([false, true])(
  'retains the stopped profile itself (existing pointer: %s)',
  async pointer => {
    const root = await mkdtemp(join(tmpdir(), 'wework-retain-profile-'))
    roots.push(root)
    const live = currentCoreProfile(root)
    const source = pointer ? join(root, 'original-profile') : live
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.json'), '{"version":"running"}')
    if (pointer) {
      await mkdir(join(live, '..'), { recursive: true })
      await symlink(source, live, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const before = await lstat(source)
    const baseline = join(root, 'retained-profile')
    await retainReleaseProfile(root, baseline)
    expect((await lstat(baseline)).ino).toBe(before.ino)
    expect(await readFile(join(live, 'package.json'), 'utf8')).toContain('running')
    const target = join(root, 'target-profile')
    await mkdir(target)
    await writeFile(join(target, 'package.json'), '{"version":"target"}')
    await selectReleaseProfile(root, target, join(root, 'legacy'))
    await writeFile(join(live, 'package.json'), '{"version":"changed-target"}')
    await selectReleaseProfile(root, baseline, join(root, 'legacy'))
    expect(await readFile(join(live, 'package.json'), 'utf8')).toBe('{"version":"running"}')
  }
)

test('reconstructs a missing profile pointer and switches it on subsequent launches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-profile-'))
  roots.push(root)
  const target = join(root, 'release-profile')
  const baseline = join(root, 'legacy-profile')
  await mkdir(target)
  await writeFile(join(target, 'package.json'), '{"version":"2"}')
  await selectReleaseProfile(root, target, baseline)
  const pointer = currentCoreProfile(root)
  expect((await lstat(pointer)).isSymbolicLink()).toBe(true)
  expect(await readFile(join(pointer, 'package.json'), 'utf8')).toContain('"2"')
  const other = join(root, 'other-profile')
  await mkdir(other)
  await writeFile(join(other, 'package.json'), '{"version":"3"}')
  await selectReleaseProfile(root, other, baseline)
  expect(await readFile(join(pointer, 'package.json'), 'utf8')).toContain('"3"')
  await selectReleaseProfile(root, other, baseline)
  expect(await readFile(join(pointer, 'package.json'), 'utf8')).toContain('"3"')
})

test('preserves the original physical profile before selecting a release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-profile-'))
  roots.push(root)
  const original = currentCoreProfile(root)
  await mkdir(original, { recursive: true })
  await writeFile(join(original, 'package.json'), '{"version":"1"}')
  const target = join(root, 'release-profile')
  await mkdir(target)
  await writeFile(join(target, 'package.json'), '{"version":"2"}')
  const baseline = join(root, 'legacy-profile')
  await selectReleaseProfile(root, target, baseline)
  expect((await lstat(baseline)).isDirectory()).toBe(true)
  expect(await readFile(join(baseline, 'package.json'), 'utf8')).toContain('"1"')
  expect(await readFile(join(original, 'package.json'), 'utf8')).toContain('"2"')
})

test('cloning an active profile pointer isolates rollback changes from the live release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-profile-clone-'))
  roots.push(root)
  const live = join(root, 'live-profile')
  await mkdir(live)
  await writeFile(join(live, 'package.json'), '{"version":"new"}')
  const component = join(root, 'component')
  await mkdir(component)
  await symlink(
    component,
    join(live, 'component'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const pointer = join(root, 'active-profile')
  await symlink(live, pointer, process.platform === 'win32' ? 'junction' : 'dir')
  const before = await profileRevision(pointer)
  const cloned = join(root, 'rollback-profile')
  expect(await cloneReleaseProfile(pointer, cloned)).toBe(before)
  expect((await lstat(cloned)).isSymbolicLink()).toBe(false)
  expect(await readlink(join(cloned, 'component'))).toBe(await readlink(join(live, 'component')))
  await writeFile(join(cloned, 'package.json'), '{"version":"old"}')
  expect(await readFile(join(pointer, 'package.json'), 'utf8')).toBe('{"version":"new"}')
  expect(await profileRevision(pointer)).toBe(before)
})
