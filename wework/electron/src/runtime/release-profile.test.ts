import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { currentCoreProfile, selectReleaseProfile } from './release-profile.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

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
